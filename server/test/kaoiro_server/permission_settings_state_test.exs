defmodule KaoiroServer.PermissionSettingsStateTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.PermissionSettings.State

  test "full-access sync preserves historical observation without enforcement" do
    requested = %{"sandbox" => "danger-full-access", "network_access" => true}
    submission = %{"revision" => 0, "requested" => requested, "execution_id" => "exec-1"}

    observation =
      Map.merge(submission, %{
        "session_id" => "session-1",
        "turn_id" => "turn-1",
        "permission" => %{"sandbox" => "danger-full-access", "approval" => "on-request"},
        "network_access" => true
      })

    constraints = %{"approval" => "on-request", "enforcement" => "os"}

    raw = %{
      "revision" => 0,
      "requested" => requested,
      "constraints" => constraints,
      "status" => "applied",
      "submitted" => submission,
      "effective" => observation,
      "last_effective" => observation
    }

    clean = State.sanitize_control(raw)
    assert {:ok, entry} = State.observe(nil, "grok", clean, 0)
    {control, next} = State.sync_view(entry)

    assert control == %{
             "revision" => 0,
             "requested" => requested,
             "constraints" => constraints,
             "status" => "pending",
             "last_effective" => observation
           }

    assert next == %{
             revision: 0,
             requested: %{sandbox: "danger-full-access", network_access: true}
           }

    refute Map.has_key?(control["last_effective"]["permission"], "enforcement")
    assert control["constraints"]["enforcement"] == "os"
  end
end
