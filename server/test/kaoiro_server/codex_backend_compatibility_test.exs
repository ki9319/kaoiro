defmodule KaoiroServer.CodexBackendCompatibilitySource do
  use GenServer

  def start_link(replies), do: GenServer.start_link(__MODULE__, replies)

  def child_spec(replies) do
    %{id: make_ref(), start: {__MODULE__, :start_link, [replies]}}
  end

  @impl true
  def init(replies), do: {:ok, replies}

  @impl true
  def handle_call(request, _from, replies), do: {:reply, Map.fetch!(replies, request), replies}
end

defmodule KaoiroServer.CodexBackendCompatibilityDefaultStoreTest do
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentActivity
  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.CodexBackendCompatibility
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServerWeb.WrapperSocket

  require Phoenix.ChannelTest

  test "the default host observation uses real wrapper, directory, pointer, and pending stores" do
    host = "legacy-host"
    live_id = "#{host}.live"
    nil_pointer_id = "#{host}.nil-pointer"
    session_pointer_id = "#{host}.session-pointer"
    directory_only_id = "#{host}.directory-only"
    reset_pending_id = "#{host}.reset-pending"
    transition_pending_id = "#{host}.transition-pending"

    ids = [
      live_id,
      nil_pointer_id,
      session_pointer_id,
      directory_only_id,
      reset_pending_id,
      transition_pending_id
    ]

    assert Application.get_env(:kaoiro_server, :session_resets_timeout_ms) >= 86_400_000
    assert Application.get_env(:kaoiro_server, :agent_activity_pending_ttl_ms) >= 86_400_000

    socket = join_wrapper(live_id)

    on_exit(fn ->
      :ok = close(socket)

      for id <- ids do
        _ = SessionResets.delete(id)
        _ = AgentActivity.delete(id)
        _ = SessionPointers.delete(id)
        _ = AgentDirectory.delete(id)
        _ = AgentStates.delete(id)
      end
    end)

    Enum.each(ids, &record_directory/1)

    SessionPointers.record(nil_pointer_id, nil, nil, :codex)
    SessionPointers.record(session_pointer_id, "persisted-session", nil, :codex)
    assert SessionPointers.get(nil_pointer_id).session_id == nil
    assert SessionPointers.get(session_pointer_id).session_id == "persisted-session"

    assert {:ok, _request_id, nil} =
             SessionResets.check_and_acquire(reset_pending_id, "new", "idle", nil)

    assert :ok =
             AgentActivity.begin_transition(
               transition_pending_id,
               "transition-proof",
               :restore,
               "2026-10-27T00:00:00Z"
             )

    live_envelope = AgentStates.snapshot()[live_id]
    assert get_in(live_envelope, ["ext", "engine"]) == "codex"
    refute Map.has_key?(live_envelope, "engine")
    assert :engine not in Map.keys(AgentDirectory.get(directory_only_id))

    assert {:ok, observation = %{"schema" => 1, "host" => ^host, "rows" => rows}} =
             CodexBackendCompatibility.observe_host(host)

    rows_by_id = Map.new(rows, &{&1["id"], &1})
    assert Map.keys(rows_by_id) |> Enum.sort() == Enum.sort(ids)

    fixture_path =
      Path.expand("../../../scripts/test/fixtures/codex-backend/server-observation.json", __DIR__)

    assert Jason.encode!(observation) <> "\n" == File.read!(fixture_path)

    assert rows_by_id[live_id]["engine"] == "codex"
    assert rows_by_id[live_id]["pointer"] == "missing"
    assert rows_by_id[live_id]["live"]
    assert rows_by_id[live_id]["connected"]

    assert rows_by_id[nil_pointer_id]["engine"] == "codex"
    assert rows_by_id[nil_pointer_id]["pointer"] == "nil"
    refute rows_by_id[nil_pointer_id]["live"]

    assert rows_by_id[session_pointer_id]["engine"] == "codex"
    assert rows_by_id[session_pointer_id]["pointer"] == "non_nil"

    assert rows_by_id[directory_only_id]["directory"]
    assert rows_by_id[directory_only_id]["pointer"] == "missing"
    assert rows_by_id[directory_only_id]["engine"] == nil

    assert rows_by_id[reset_pending_id]["reset_pending"]
    assert rows_by_id[reset_pending_id]["engine"] == nil
    assert rows_by_id[transition_pending_id]["transition_pending"]
    assert rows_by_id[transition_pending_id]["engine"] == nil
    refute inspect(rows) =~ "transition-proof"
  end

  test "a distinct real engine rejects static golden substitution" do
    host = "engine-ledger"
    claude_id = "#{host}.claude"
    socket = join_wrapper(claude_id, "claude-code")

    on_exit(fn ->
      :ok = close(socket)
      _ = AgentActivity.delete(claude_id)
      _ = SessionPointers.delete(claude_id)
      _ = AgentDirectory.delete(claude_id)
      _ = AgentStates.delete(claude_id)
    end)

    record_directory(claude_id)

    assert {:ok, %{"schema" => 1, "host" => ^host, "rows" => [row]}} =
             CodexBackendCompatibility.observe_host(host)

    assert row == %{
             "id" => claude_id,
             "directory" => true,
             "pointer" => "missing",
             "engine" => "claude-code",
             "live" => true,
             "connected" => true,
             "reset_pending" => false,
             "transition_pending" => false
           }
  end

  defp record_directory(agent_id) do
    assert :ok = AgentDirectory.record(agent_id, "default", "Compatibility test")
    assert AgentDirectory.get(agent_id)
  end

  defp join_wrapper(agent_id, engine \\ "codex") do
    {:ok, _reply, socket} =
      WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(
        KaoiroServerWeb.WrapperChannel,
        "wrapper:" <> agent_id,
        %{"persona_id" => "default"}
      )

    ref =
      push(socket, "envelope", %{
        "version" => "0",
        "agent_id" => agent_id,
        "persona" => %{"id" => "default", "name" => "Default", "sprite_set" => "default"},
        "ts" => "2026-10-27T00:00:00Z",
        "type" => "state_change",
        "state" => "tool_running",
        "payload" => %{},
        "ext" => %{"engine" => engine}
      })

    assert_reply(ref, :ok)
    socket
  end
end

defmodule KaoiroServer.CodexBackendCompatibilityTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.AgentActivity
  alias KaoiroServer.CodexBackendCompatibility

  test "host observation includes union members and a real pending transition" do
    host = "alpha.beta"
    live_id = "#{host}.live"
    offline_id = "#{host}.offline"
    activity = start_supervised!({AgentActivity, name: nil}, id: :compatibility_activity)

    directory =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{all: %{live_id => %{}, offline_id => %{}, "alpha.betal.other" => %{}}}
      })

    pointers =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{all: %{live_id => %{session_id: nil, engine: :codex}}}
      })

    states =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{
          snapshot: %{live_id => %{"ext" => %{"engine" => "codex"}}},
          connected_ids: MapSet.new([live_id])
        }
      })

    resets =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{pending_ids: MapSet.new([offline_id])}
      })

    assert :ok =
             AgentActivity.begin_transition(
               live_id,
               "transition-secret",
               :restore,
               "2026-10-27T00:00:00Z",
               server: activity
             )

    assert {:ok, %{"schema" => 1, "host" => ^host, "rows" => [live, offline]}} =
             CodexBackendCompatibility.observe_host(host,
               directory_server: directory,
               pointers_server: pointers,
               states_server: states,
               resets_server: resets,
               activity_server: activity
             )

    assert live == %{
             "id" => live_id,
             "directory" => true,
             "pointer" => "nil",
             "engine" => "codex",
             "live" => true,
             "connected" => true,
             "reset_pending" => false,
             "transition_pending" => true
           }

    assert offline == %{
             "id" => offline_id,
             "directory" => true,
             "pointer" => "missing",
             "engine" => nil,
             "live" => false,
             "connected" => false,
             "reset_pending" => true,
             "transition_pending" => false
           }

    refute inspect(live) =~ "transition-secret"
  end

  test "unavailable source returns an error instead of a partial host view" do
    directory = start_supervised!({KaoiroServer.CodexBackendCompatibilitySource, %{all: %{}}})

    assert {:error, {:observation_unavailable, :pointers}} =
             CodexBackendCompatibility.observe_host("host",
               directory_server: directory,
               pointers_server: :missing_compat_pointer_store
             )
  end

  test "conflicting pointer and wrapper engines invalidate the host observation" do
    host = "engine-conflict"
    agent_id = "#{host}.agent"

    directory =
      start_supervised!(
        {KaoiroServer.CodexBackendCompatibilitySource, %{all: %{agent_id => %{}}}}
      )

    pointers =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{all: %{agent_id => %{session_id: nil, engine: :codex}}}
      })

    states =
      start_supervised!({
        KaoiroServer.CodexBackendCompatibilitySource,
        %{
          snapshot: %{agent_id => %{"ext" => %{"engine" => "claude-code"}}},
          connected_ids: MapSet.new()
        }
      })

    resets =
      start_supervised!(
        {KaoiroServer.CodexBackendCompatibilitySource, %{pending_ids: MapSet.new()}}
      )

    activity =
      start_supervised!(
        {KaoiroServer.CodexBackendCompatibilitySource, %{pending_ids: MapSet.new()}}
      )

    assert {:error, :invalid_observation} =
             CodexBackendCompatibility.observe_host(host,
               directory_server: directory,
               pointers_server: pointers,
               states_server: states,
               resets_server: resets,
               activity_server: activity
             )
  end

  test "invalid host identifiers are refused" do
    assert {:error, :invalid_host_id} = CodexBackendCompatibility.observe_host("bad/host")
  end
end
