defmodule Mix.Tasks.Permission.Differential do
  @moduledoc false
  use Mix.Task

  @impl Mix.Task
  def run(_) do
    result = KaoiroServer.PermissionDifferential.compute()
    path = Path.join(KaoiroServer.PermissionDifferential.directory(), "expected.json")
    File.write!(path, Jason.encode!(result) <> "\n")
    Mix.shell().info("permission differential: #{length(result["rows"])} rows")
  end
end
