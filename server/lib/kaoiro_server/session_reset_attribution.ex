defmodule KaoiroServer.SessionResetAttribution do
  @moduledoc """
  Closed detail shape for the server-authored `session_reset_started`
  lifecycle event (issue #677). Mirrors `DisconnectAttribution`, but
  returns the re-extracted map instead of a boolean: the stored record
  contains only the keys listed here, so an extra field on the input can
  never ride into the timeline even when every required field validates.

  `origin` is the same vocabulary the `session_reset_started` broadcast
  carries. `director` is the only origin that names a requester, because
  it is the only one where the requester is not the agent itself and not
  the operator.
  """

  @origins ~w(operator agent_self director)
  @max_id_bytes 256
  @max_work_id_bytes 128

  @doc """
  Returns `{:ok, sanitized}` with exactly the closed keys for `origin`, or
  `:error` when the shape is not one the server would author.
  """
  def sanitize(%{"origin" => "director"} = details) do
    with %{"requested_by" => %{"kind" => "agent", "id" => id}, "work_id" => work_id} <- details,
         true <- bounded?(id, @max_id_bytes),
         true <- bounded?(work_id, @max_work_id_bytes) do
      {:ok,
       %{
         "origin" => "director",
         "requested_by" => %{"kind" => "agent", "id" => id},
         "work_id" => work_id
       }}
    else
      _ -> :error
    end
  end

  def sanitize(%{"origin" => origin} = details) when origin in @origins do
    if Map.has_key?(details, "requested_by") or Map.has_key?(details, "work_id"),
      do: :error,
      else: {:ok, %{"origin" => origin}}
  end

  def sanitize(_details), do: :error

  @doc "True when `details` sanitizes to itself (used for stored-record re-validation)."
  def valid?(details) when is_map(details) do
    match?({:ok, ^details}, sanitize(details))
  end

  def valid?(_details), do: false

  defp bounded?(value, max),
    do: is_binary(value) and value != "" and byte_size(value) <= max
end
