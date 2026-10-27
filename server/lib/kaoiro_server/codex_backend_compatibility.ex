defmodule KaoiroServer.CodexBackendCompatibility do
  @moduledoc """
  Read-only, host-scoped observations for the Codex backend preparation
  workflow. The projection deliberately excludes session IDs, cwd, snapshots,
  envelope contents, process owners, and lifecycle transaction metadata.
  """

  alias KaoiroServer.AgentActivity
  alias KaoiroServer.AgentDirectory
  alias KaoiroServer.AgentStates
  alias KaoiroServer.SessionPointers
  alias KaoiroServer.SessionResets
  alias KaoiroServerWeb.AgentId

  @host_id_pattern ~r/^[A-Za-z0-9._-]+$/

  @doc "Returns the complete allowlisted host projection or an unavailable error."
  def observe_host(host_id, opts \\ []) when is_binary(host_id) do
    if Regex.match?(@host_id_pattern, host_id) do
      with {:ok, directory} <-
             source(
               :directory,
               fn -> AgentDirectory.all(server(opts, :directory)) end,
               &valid_map?/1
             ),
           {:ok, pointers} <-
             source(
               :pointers,
               fn -> SessionPointers.all(server(opts, :pointers)) end,
               &valid_map?/1
             ),
           {:ok, states} <-
             source(:states, fn -> AgentStates.snapshot(server(opts, :states)) end, &valid_map?/1),
           {:ok, connected} <-
             source(
               :connections,
               fn -> AgentStates.connected_ids(server: server(opts, :states)) end,
               &valid_id_set?/1
             ),
           {:ok, reset_pending} <-
             source(
               :resets,
               fn -> SessionResets.pending_ids(server(opts, :resets)) end,
               &valid_id_set?/1
             ),
           {:ok, transition_pending} <-
             source(
               :transitions,
               fn -> AgentActivity.pending_ids(server(opts, :activity)) end,
               &valid_id_set?/1
             ),
           :ok <- validate_map_ids(directory),
           :ok <- validate_map_ids(pointers),
           :ok <- validate_map_ids(states),
           :ok <- validate_id_set(connected),
           :ok <- validate_id_set(reset_pending),
           :ok <- validate_id_set(transition_pending),
           {:ok, rows} <-
             project_rows(
               host_id,
               directory,
               pointers,
               states,
               connected,
               reset_pending,
               transition_pending
             ) do
        {:ok, %{"schema" => 1, "host" => host_id, "rows" => rows}}
      end
    else
      {:error, :invalid_host_id}
    end
  end

  def observe_host(_host_id, _opts), do: {:error, :invalid_host_id}

  defp server(opts, key) do
    Keyword.get(opts, server_option(key), module_for(key))
  end

  defp server_option(:directory), do: :directory_server
  defp server_option(:pointers), do: :pointers_server
  defp server_option(:states), do: :states_server
  defp server_option(:resets), do: :resets_server
  defp server_option(:activity), do: :activity_server

  defp module_for(:directory), do: AgentDirectory
  defp module_for(:pointers), do: SessionPointers
  defp module_for(:states), do: AgentStates
  defp module_for(:resets), do: SessionResets
  defp module_for(:activity), do: AgentActivity

  defp source(name, reader, valid?) do
    try do
      value = reader.()
      if valid?.(value), do: {:ok, value}, else: {:error, {:observation_unavailable, name}}
    rescue
      _ -> {:error, {:observation_unavailable, name}}
    catch
      :exit, _ -> {:error, {:observation_unavailable, name}}
    end
  end

  defp valid_map?(value), do: is_map(value)
  defp valid_id_set?(%MapSet{}), do: true
  defp valid_id_set?(_), do: false

  defp validate_map_ids(map) do
    if Enum.all?(Map.keys(map), &(is_binary(&1) and AgentId.valid?(&1))),
      do: :ok,
      else: {:error, :invalid_observation}
  end

  defp validate_id_set(ids) do
    if Enum.all?(ids, &(is_binary(&1) and AgentId.valid?(&1))),
      do: :ok,
      else: {:error, :invalid_observation}
  end

  defp project_rows(
         host_id,
         directory,
         pointers,
         states,
         connected,
         reset_pending,
         transition_pending
       ) do
    ids =
      [
        Map.keys(directory),
        Map.keys(pointers),
        Map.keys(states),
        MapSet.to_list(connected),
        MapSet.to_list(reset_pending),
        MapSet.to_list(transition_pending)
      ]
      |> List.flatten()
      |> Enum.uniq()
      |> Enum.filter(&(AgentId.host_id_from(&1) == host_id))
      |> Enum.sort()

    Enum.reduce_while(ids, {:ok, []}, fn id, {:ok, rows} ->
      case project_row(
             id,
             directory,
             pointers,
             states,
             connected,
             reset_pending,
             transition_pending
           ) do
        {:ok, row} -> {:cont, {:ok, [row | rows]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, rows} -> {:ok, Enum.reverse(rows)}
      error -> error
    end
  end

  defp project_row(id, directory, pointers, states, connected, reset_pending, transition_pending) do
    pointer = Map.get(pointers, id, :missing)
    state = Map.get(states, id)

    with {:ok, pointer_state} <- pointer_state(pointer),
         {:ok, engine} <- engine(pointer, state) do
      {:ok,
       %{
         "id" => id,
         "directory" => Map.has_key?(directory, id),
         "pointer" => pointer_state,
         "engine" => engine,
         "live" => not is_nil(state),
         "connected" => MapSet.member?(connected, id),
         "reset_pending" => MapSet.member?(reset_pending, id),
         "transition_pending" => MapSet.member?(transition_pending, id)
       }}
    end
  end

  defp pointer_state(:missing), do: {:ok, "missing"}

  defp pointer_state(pointer) when is_map(pointer) do
    case Map.fetch(pointer, :session_id) do
      {:ok, nil} -> {:ok, "nil"}
      {:ok, session_id} when is_binary(session_id) and session_id != "" -> {:ok, "non_nil"}
      _ -> {:error, :invalid_observation}
    end
  end

  defp pointer_state(_), do: {:error, :invalid_observation}

  defp engine(pointer, state) do
    pointer_engine = if is_map(pointer), do: Map.get(pointer, :engine), else: nil

    state_engine =
      if is_map(state), do: Map.get(state, "engine", Map.get(state, :engine)), else: nil

    with {:ok, pointer_engine} <- normalize_engine(pointer_engine),
         {:ok, state_engine} <- normalize_engine(state_engine),
         true <- is_nil(pointer_engine) or is_nil(state_engine) or pointer_engine == state_engine do
      {:ok, pointer_engine || state_engine}
    else
      _ -> {:error, :invalid_observation}
    end
  end

  defp normalize_engine(nil), do: {:ok, nil}
  defp normalize_engine(engine) when is_binary(engine) and engine != "", do: {:ok, engine}
  defp normalize_engine(engine) when is_atom(engine), do: {:ok, Atom.to_string(engine)}
  defp normalize_engine(_), do: {:error, :invalid_observation}
end
