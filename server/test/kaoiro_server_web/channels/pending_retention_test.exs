defmodule KaoiroServerWeb.PendingRetentionTest do
  # issue 503: an ext-less envelope that follows a pending permission or
  # question must not erase the pending state the next join snapshot shows.
  use KaoiroServerWeb.ChannelCase, async: false

  alias KaoiroServer.AgentStates

  setup do
    Application.put_env(:kaoiro_server, :client_tokens, "tok-operator:operator")
    on_exit(fn -> Application.delete_env(:kaoiro_server, :client_tokens) end)
    id = "test.pending-retention-#{System.unique_integer([:positive])}"
    on_exit(fn -> AgentStates.delete(id) end)
    %{id: id}
  end

  defp join_operator do
    fingerprint = KaoiroServer.Auth.socket_id("tok-operator")

    {:ok, _reply, socket} =
      KaoiroServerWeb.ClientSocket
      |> socket(nil, %{
        role: :operator,
        credential: {:token_fingerprint, fingerprint},
        socket_id: fingerprint
      })
      |> subscribe_and_join(KaoiroServerWeb.AgentsChannel, "agents:lobby")

    socket
  end

  defp join_wrapper(id) do
    {:ok, _reply, socket} =
      KaoiroServerWeb.WrapperSocket
      |> socket(nil, %{})
      |> subscribe_and_join(KaoiroServerWeb.WrapperChannel, "wrapper:" <> id, %{
        "persona_id" => "default"
      })

    socket
  end

  defp envelope(id, type, state, ext, payload \\ %{}) do
    %{
      "version" => "0",
      "agent_id" => id,
      "persona" => %{"id" => "mio", "name" => "澪", "sprite_set" => "mio"},
      "ts" => "2026-10-27T00:00:00Z",
      "type" => type,
      "state" => state,
      "payload" => payload,
      "ext" => ext
    }
  end

  defp pending_permission(request_id) do
    %{
      "pending_permission" => %{
        "request_id" => request_id,
        "tool_name" => "Bash",
        "input" => %{"command" => "ls"},
        "ts" => "2026-10-27T00:00:00Z"
      }
    }
  end

  defp pending_question(request_id) do
    %{
      "pending_question" => %{
        "request_id" => request_id,
        "questions" => [
          %{
            "question" => "Which?",
            "header" => "Pick",
            "multiSelect" => false,
            "options" => [
              %{"label" => "A", "description" => "a"},
              %{"label" => "B", "description" => "b"}
            ]
          }
        ],
        "ts" => "2026-10-27T00:00:00Z"
      }
    }
  end

  defp instruction_rejected(id, state) do
    envelope(id, "instruction_rejected", state, %{}, %{"reason" => "busy"})
  end

  defp attach_rejected(id, state) do
    envelope(id, "attach_rejected", state, %{}, %{"upload_id" => "u-1", "reason" => "too_large"})
  end

  defp push_ok(wrapper, env), do: assert_reply(push(wrapper, "envelope", env), :ok)

  # Each join pushes its own snapshot, so read it before the next join.
  defp join_snapshot(id) do
    socket = join_operator()
    assert_push "snapshot", %{"agents" => agents}
    {socket, agents[id]}
  end

  defp snapshot_entry(id), do: id |> join_snapshot() |> elem(1)

  defp refute_pending(entry) do
    ext = entry["ext"] || %{}
    refute Map.has_key?(ext, "pending_permission")
    refute Map.has_key?(ext, "pending_question")
  end

  for {label, rejected} <- [
        {"instruction_rejected", :instruction_rejected},
        {"attach_rejected", :attach_rejected}
      ] do
    test "pending permission survives a later #{label}, is answered, then stays cleared",
         %{id: id} do
      wrapper = join_wrapper(id)
      @endpoint.subscribe("wrapper:" <> id)

      push_ok(
        wrapper,
        envelope(id, "state_change", "waiting_permission", pending_permission("req-1"))
      )

      push_ok(
        wrapper,
        apply(__MODULE__, :__rejected__, [unquote(rejected), id, "waiting_permission"])
      )

      {operator, entry} = join_snapshot(id)
      assert entry["type"] == unquote(label)
      assert entry["state"] == "waiting_permission"
      request_id = get_in(entry, ["ext", "pending_permission", "request_id"])
      assert request_id == "req-1"

      ref =
        push(operator, "permission_decision", %{
          "agent_id" => id,
          "request_id" => request_id,
          "allow" => true
        })

      assert_reply ref, :ok
      assert_broadcast "permission_decision", %{"request_id" => ^request_id, "allow" => true}

      # The wrapper's authoritative clear after the broker settles.
      push_ok(wrapper, envelope(id, "state_change", "tool_running", %{}))
      push_ok(wrapper, apply(__MODULE__, :__rejected__, [unquote(rejected), id, "tool_running"]))

      refute_pending(snapshot_entry(id))
    end
  end

  def __rejected__(:instruction_rejected, id, state), do: instruction_rejected(id, state)
  def __rejected__(:attach_rejected, id, state), do: attach_rejected(id, state)

  test "pending question survives a later instruction_rejected, is answered, then stays cleared",
       %{id: id} do
    wrapper = join_wrapper(id)
    @endpoint.subscribe("wrapper:" <> id)
    push_ok(wrapper, envelope(id, "state_change", "waiting_question", pending_question("q-1")))
    push_ok(wrapper, instruction_rejected(id, "waiting_question"))

    {operator, entry} = join_snapshot(id)
    request_id = get_in(entry, ["ext", "pending_question", "request_id"])
    assert request_id == "q-1"

    ref =
      push(operator, "question_response", %{
        "agent_id" => id,
        "request_id" => request_id,
        "answers" => %{"Which?" => "A"}
      })

    assert_reply ref, :ok
    assert_broadcast "question_response", %{"request_id" => ^request_id}

    push_ok(wrapper, envelope(id, "state_change", "thinking", %{}))
    push_ok(wrapper, instruction_rejected(id, "thinking"))

    refute_pending(snapshot_entry(id))
  end

  test "the live broadcast of the ext-less envelope carries the retained pending", %{id: id} do
    wrapper = join_wrapper(id)

    push_ok(
      wrapper,
      envelope(id, "state_change", "waiting_permission", pending_permission("req-2"))
    )

    _operator = join_operator()
    assert_push "snapshot", _

    push_ok(wrapper, instruction_rejected(id, "waiting_permission"))

    assert_push "envelope", %{"type" => "instruction_rejected"} = pushed
    assert get_in(pushed, ["ext", "pending_permission", "request_id"]) == "req-2"
  end

  test "a state_change without pending clears it, and a later ext-less envelope does not revive it",
       %{id: id} do
    wrapper = join_wrapper(id)

    push_ok(
      wrapper,
      envelope(id, "state_change", "waiting_permission", pending_permission("req-3"))
    )

    push_ok(wrapper, envelope(id, "state_change", "tool_running", %{}))
    push_ok(wrapper, instruction_rejected(id, "tool_running"))

    refute_pending(snapshot_entry(id))
  end

  test "the ext-less envelope's own pending wins over the retained one", %{id: id} do
    wrapper = join_wrapper(id)

    push_ok(
      wrapper,
      envelope(id, "state_change", "waiting_permission", pending_permission("req-4"))
    )

    push_ok(
      wrapper,
      envelope(id, "instruction_rejected", "waiting_permission", pending_permission("req-5"), %{
        "reason" => "busy"
      })
    )

    entry = snapshot_entry(id)
    assert get_in(entry, ["ext", "pending_permission", "request_id"]) == "req-5"
  end

  test "an explicit null in the incoming ext wins over the retained pending", %{id: id} do
    wrapper = join_wrapper(id)

    push_ok(
      wrapper,
      envelope(id, "state_change", "waiting_permission", pending_permission("req-6"))
    )

    push_ok(
      wrapper,
      envelope(
        id,
        "instruction_rejected",
        "waiting_permission",
        %{"pending_permission" => nil},
        %{"reason" => "busy"}
      )
    )

    entry = snapshot_entry(id)
    assert Map.fetch!(entry["ext"], "pending_permission") == nil
  end

  test "a disconnect drops the retained pending and a reconnect does not revive it",
       %{id: id} do
    Process.flag(:trap_exit, true)
    wrapper = join_wrapper(id)

    push_ok(
      wrapper,
      envelope(id, "state_change", "waiting_permission", pending_permission("req-7"))
    )

    push_ok(wrapper, instruction_rejected(id, "waiting_permission"))
    assert get_in(snapshot_entry(id), ["ext", "pending_permission", "request_id"]) == "req-7"

    :ok = close(wrapper)
    entry = snapshot_entry(id)
    assert entry["state"] == "disconnected"
    refute_pending(entry)

    reconnected = join_wrapper(id)
    push_ok(reconnected, instruction_rejected(id, "idle"))
    refute_pending(snapshot_entry(id))
  end
end
