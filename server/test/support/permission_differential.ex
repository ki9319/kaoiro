defmodule KaoiroServer.PermissionDifferential do
  @moduledoc false
  alias KaoiroServer.PermissionSettings.State
  @directory Path.expand("../../../protocol/fixtures/permission-differential", __DIR__)

  def directory, do: @directory

  def compute do
    data = @directory |> Path.join("scenarios.json") |> File.read!() |> Jason.decode!()
    "adopted_server_control" = data["rejoin_report"]

    pairs =
      Enum.map(data["pairs"], fn [sandbox, network] ->
        %{sandbox: sandbox, network_access: network}
      end)

    reports = Enum.map(data["reports"], &report(&1, pairs))

    {_, rows, _, controls, checked, excluded} =
      data["rows"]
      |> Enum.with_index()
      |> Enum.reduce({%{}, [], %{}, [], 0, 0}, fn {[parent, event, indexes, _, _, _], id},
                                                  {states, rows, interned, controls, checked,
                                                   excluded} ->
        previous = Map.get(states, parent)

        entry =
          if parent >= 0 and event <= 2 do
            {:ok, _, entry} =
              State.submit(
                previous,
                previous.control.revision,
                "grok",
                Enum.at(pairs, event + 1),
                %{kind: "user", id: "fixture"},
                "2026-01-01T00:00:00Z"
              )

            entry
          else
            previous
          end

        entry =
          indexes
          |> Enum.reject(&(&1 == "adopted_server_control"))
          |> Enum.reduce(entry, fn index, entry ->
            sanitized = reports |> Enum.at(index) |> State.sanitize_control()

            case State.observe(
                   entry,
                   "grok",
                   sanitized,
                   if(entry, do: entry.control.revision, else: 0)
                 ) do
              {:ok, value} -> value
              :no_change -> entry
            end
          end)

        {sync, next} = State.sync_view(entry)

        {checked, excluded} =
          if parent >= 0 and event >= 7 do
            ["adopted_server_control"] = indexes

            if sync["status"] == "unknown" or
                 (sync["status"] == "failed" and Map.has_key?(sync, "rolled_back_to")) do
              echoed = observe_rejoin(entry, sync)

              if State.sync_view(echoed) != {sync, next} do
                raise "rejoin control report changed the server expectation at row #{id}"
              end

              {checked + 1, excluded}
            else
              # Applied controls become pending on sync; observing the echo can
              # restore submitted. See https://github.com/sakuraiyuta/kaoiro/issues/618.
              {checked, excluded + 1}
            end
          else
            {checked, excluded}
          end

        key = Jason.encode!(sync)

        {index, interned, controls} =
          case Map.fetch(interned, key) do
            {:ok, index} ->
              {index, interned, controls}

            :error ->
              index = length(controls)
              {index, Map.put(interned, key, index), [sync | controls]}
          end

        pair_index = fn pair -> Enum.find_index(pairs, &(&1 == pair)) end

        row = [
          [
            entry.control.revision,
            Atom.to_string(entry.control.status),
            pair_index.(entry.control.requested),
            if(entry.control.rolled_back_to, do: pair_index.(entry.control.rolled_back_to))
          ],
          [next.revision, pair_index.(next.requested)],
          index
        ]

        {Map.put(states, id, entry), [row | rows], interned, controls, checked, excluded}
      end)

    IO.puts(Jason.encode!(%{rejoin_echo_checked: checked, rejoin_pending_excluded: excluded}))
    %{"version" => 1, "rows" => Enum.reverse(rows), "controls" => Enum.reverse(controls)}
  end

  defp observe_rejoin(entry, control) do
    case State.observe(entry, "grok", State.sanitize_control(control), entry.control.revision) do
      {:ok, value} -> value
      :no_change -> entry
    end
  end

  defp report([revision, status, pair | submitted], pairs) do
    requested = Enum.at(pairs, pair)
    wire_pair = %{"sandbox" => requested.sandbox, "network_access" => requested.network_access}

    base = %{
      "revision" => revision,
      "requested" => wire_pair,
      "status" => status,
      "constraints" => %{"approval" => "on-request", "enforcement" => "os"}
    }

    submission = %{
      "revision" => revision,
      "requested" => wire_pair,
      "execution_id" => "execution"
    }

    base = if submitted == [], do: base, else: Map.put(base, "submitted", submission)

    base =
      if status in ["failed", "unknown"],
        do: Map.put(base, "reason", "fixture_failure"),
        else: base

    if status == "applied" do
      observation =
        Map.merge(submission, %{
          "session_id" => "session",
          "turn_id" => "prompt",
          "permission" => %{
            "sandbox" => requested.sandbox,
            "approval" => "on-request",
            "enforcement" => "os"
          },
          "network_access" =>
            requested.sandbox == "danger-full-access" or
              (requested.sandbox == "workspace-write" and requested.network_access)
        })

      Map.put(base, "effective", observation)
    else
      base
    end
  end
end
