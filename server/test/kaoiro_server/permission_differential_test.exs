defmodule KaoiroServer.PermissionDifferentialTest do
  use ExUnit.Case, async: true

  test "committed expectations match the actual permission state transitions" do
    path = Path.join(KaoiroServer.PermissionDifferential.directory(), "expected.json")
    assert Jason.decode!(File.read!(path)) == KaoiroServer.PermissionDifferential.compute()
  end
end
