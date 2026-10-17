defmodule KaoiroServer.SessionResetAttributionTest do
  use ExUnit.Case, async: true

  alias KaoiroServer.SessionResetAttribution

  @requester %{"kind" => "agent", "id" => "host.director"}

  test "operator and agent_self sanitize to the origin alone" do
    assert {:ok, %{"origin" => "operator"}} =
             SessionResetAttribution.sanitize(%{"origin" => "operator"})

    assert {:ok, %{"origin" => "agent_self"}} =
             SessionResetAttribution.sanitize(%{"origin" => "agent_self"})
  end

  test "director requires requested_by and work_id and keeps only those keys" do
    input = %{
      "origin" => "director",
      "requested_by" => Map.put(@requester, "display_name", "not stored"),
      "work_id" => "wrk_1",
      "prompt" => "never stored"
    }

    assert {:ok, sanitized} = SessionResetAttribution.sanitize(input)

    assert sanitized == %{
             "origin" => "director",
             "requested_by" => @requester,
             "work_id" => "wrk_1"
           }

    assert SessionResetAttribution.valid?(sanitized)
    refute SessionResetAttribution.valid?(input)
  end

  test "rejects shapes the server never authors" do
    for details <- [
          %{"origin" => "director"},
          %{"origin" => "director", "requested_by" => @requester},
          %{"origin" => "director", "work_id" => "wrk_1"},
          %{
            "origin" => "director",
            "requested_by" => %{"kind" => "user", "id" => "1"},
            "work_id" => "w"
          },
          %{"origin" => "director", "requested_by" => @requester, "work_id" => ""},
          %{
            "origin" => "director",
            "requested_by" => @requester,
            "work_id" => String.duplicate("w", 129)
          },
          %{
            "origin" => "director",
            "requested_by" => %{"kind" => "agent", "id" => String.duplicate("a", 257)},
            "work_id" => "w"
          },
          %{"origin" => "operator", "requested_by" => @requester},
          %{"origin" => "agent_self", "work_id" => "wrk_1"},
          %{"origin" => "runner"},
          %{},
          nil,
          "director"
        ] do
      assert :error == SessionResetAttribution.sanitize(details), inspect(details)
      refute SessionResetAttribution.valid?(details), inspect(details)
    end
  end
end
