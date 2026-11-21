import type { PluginServerContext } from "@getpaseo/plugin/server";
import { presentationSettings } from "./shared/settings";
import { migrateHostSettings } from "./server/settings-migration";
import { requireHostMethods, STARTUP_MESSAGES } from "./shared/startup-diagnostics";

export default function contribute(server: PluginServerContext) {
  requireHostMethods(server, ["registerSettings", "handle"]);
  try {
    return registerServer(server);
  } catch {
    throw new Error(STARTUP_MESSAGES.startupFailed);
  }
}

function registerServer(server: PluginServerContext) {
  migrateHostSettings();
  server.registerSettings(presentationSettings);
  return () => {};
}
