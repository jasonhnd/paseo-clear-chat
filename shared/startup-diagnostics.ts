/** Only fixed messages may cross the host boundary; errors can contain private paths. */
export const STARTUP_MESSAGES = {
  incompatibleHost: "Clear Chat requires Paseo plugin settings and timeline support. Update Paseo on the daemon host and all connected apps, then reload Clear Chat.",
  startupFailed: "Clear Chat could not start because Paseo could not register the plugin. Update Paseo and reload Clear Chat. If it still fails, back up the plugin settings before reinstalling with the Paseo CLI.",
  settingsRead: "Clear Chat cannot read its host settings. Reconnect to the selected host, then select Retry. If it still fails, check the daemon's access to the plugin settings folder.",
  settingsInvalid: "Clear Chat settings are invalid or use an unsupported format. Back up the plugin settings, restore a valid backup or repair the settings file on the daemon host, then select Retry.",
  settingsWrite: "Clear Chat cannot save its host settings. Check the daemon's write access and available disk space, reconnect, then try the setting again.",
  settingsConflict: "Clear Chat settings keep changing in another client. Wait for other edits to finish, then try the setting again.",
  migrationFailed: "Clear Chat could not copy the Beautiful Chat settings; startup will continue. Keep the original settings and back them up, check the daemon's read and write access to both plugin settings folders and available disk space, then reload Clear Chat to retry.",
} as const;

export function requireHostMethods(context: unknown, methods: readonly string[]): void {
  if (!context || typeof context !== "object" || methods.some(name => typeof (context as Record<string, unknown>)[name] !== "function")) {
    throw new Error(STARTUP_MESSAGES.incompatibleHost);
  }
}
