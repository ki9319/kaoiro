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
        %{snapshot: %{live_id => %{"engine" => "codex"}}, connected_ids: MapSet.new([live_id])}
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

  test "invalid host identifiers are refused" do
    assert {:error, :invalid_host_id} = CodexBackendCompatibility.observe_host("bad/host")
  end
end
