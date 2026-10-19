import { execFileSync } from "node:child_process";
import net from "node:net";

/** Throws unless every isolation layer is active in this test process. */
export async function assertIsolationActive() {
  if (!globalThis[Symbol.for("kaoiro.test.isolation")]) throw new Error("test isolation is not loaded in this process");
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"]) {
    if (process.env[key] !== undefined) throw new Error(`test isolation left ${key} in the environment`);
  }
  if (!process.env.DBUS_SESSION_BUS_ADDRESS?.includes("kaoiro-test-isolation-")) {
    throw new Error("test isolation did not replace the session bus address");
  }
  let command;
  try { execFileSync("systemctl", ["--version"], { stdio: "ignore" }); } catch (error) { command = error.code; }
  if (command !== "ERR_TEST_HOST_SYSTEMD") throw new Error(`host systemctl was not refused: ${command}`);
  const network = await new Promise(resolve => {
    const socket = net.connect({ host: "192.0.2.1", port: 9 });
    socket.setTimeout(3000, () => { socket.destroy(); resolve("timeout"); });
    socket.once("error", error => resolve(error.code));
    socket.once("connect", () => { socket.destroy(); resolve("connected"); });
  });
  if (network !== "ERR_TEST_NETWORK") throw new Error(`outbound network was not refused: ${network}`);
}
