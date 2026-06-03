import {
  initialize,
  DrumRack,
  RackDevice,
  Simpler,
  Track,
  type Device,
  type ActivationContext,
} from "@ableton-extensions/sdk";
import dialogHtml from "./dialog.html";

type Action = "disable" | "enable" | "delete" | "cancel";

interface DeviceEntry {
  displayName: string;
  typeKey: string; // "instanceof:DrumRack" | "name:<device.name>"
  count: number;
}

interface DialogResult {
  action: Action;
  typeKey?: string;
}

const DEVICE_ON_PARAM = "Device On";

function getDeviceIdentity(device: Device<"1.0.0">): {
  displayName: string;
  typeKey: string;
} {
  if (device instanceof DrumRack) {
    return { displayName: "Drum Rack", typeKey: "instanceof:DrumRack" };
  }
  // RackDevice covers Instrument Rack, Audio Effect Rack, and MIDI Effect Rack.
  // We can't distinguish between them via the SDK, so we fall back to device.name
  // which is correct when no preset is loaded ("Instrument Rack" etc.) and shows
  // the preset name otherwise — same limitation as plain devices.
  if (device instanceof Simpler) {
    return { displayName: "Simpler", typeKey: "instanceof:Simpler" };
  }
  return { displayName: device.name, typeKey: `name:${device.name}` };
}

function matchesTypeKey(device: Device<"1.0.0">, typeKey: string): boolean {
  if (typeKey === "instanceof:DrumRack") return device instanceof DrumRack;
  if (typeKey === "instanceof:Simpler") return device instanceof Simpler;
  // Keep RackDevice fallback so name-matched racks still work
  if (typeKey.startsWith("name:")) {
    const name = typeKey.slice(5);
    return device.name === name && !(device instanceof DrumRack);
  }
  return false;
}

function buildDeviceEntries(allTracks: Track<"1.0.0">[]): DeviceEntry[] {
  const map = new Map<string, { displayName: string; count: number }>();
  for (const track of allTracks) {
    for (const device of track.devices) {
      const { displayName, typeKey } = getDeviceIdentity(device);
      const entry = map.get(typeKey);
      if (entry) {
        entry.count++;
      } else {
        map.set(typeKey, { displayName, count: 1 });
      }
    }
  }
  return [...map.entries()]
    .map(([typeKey, { displayName, count }]) => ({ typeKey, displayName, count }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  async function openDialog(): Promise<void> {
    const song = context.application.song;
    const allTracks = [...song.tracks, ...song.returnTracks];
    const entries = buildDeviceEntries(allTracks);

    if (entries.length === 0) {
      console.log("No devices found in this project.");
      return;
    }

    const html = dialogHtml.replace(
      "__DEVICES__",
      JSON.stringify(entries),
    );

    let result: DialogResult;
    try {
      const raw = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(html)}`,
        620,
        460,
      );
      result = JSON.parse(raw) as DialogResult;
    } catch {
      return;
    }

    if (result.action === "cancel" || !result.typeKey) return;

    const { typeKey, action } = result;

    if (action === "disable" || action === "enable") {
      const enabled = action === "enable";
      const targetParams = allTracks.flatMap((t) =>
        t.devices
          .filter((d) => matchesTypeKey(d, typeKey))
          .flatMap((d) => {
            const param = d.parameters.find((p) => p.name === DEVICE_ON_PARAM);
            if (!param) {
              console.warn(
                `"${DEVICE_ON_PARAM}" not found on device in track "${t.name}". ` +
                  `Parameters: ${d.parameters.map((p) => p.name).join(", ")}`,
              );
              return [];
            }
            return [param];
          }),
      );

      if (targetParams.length === 0) {
        console.log("No matching devices found.");
        return;
      }

      await context.withinTransaction(() =>
        Promise.all(targetParams.map((p) => p.setValue(enabled ? 1 : 0))),
      );
      console.log(`${enabled ? "Enabled" : "Disabled"} ${targetParams.length} device(s).`);
    }

    if (action === "delete") {
      const toDelete = allTracks.flatMap((t) =>
        t.devices
          .filter((d) => matchesTypeKey(d, typeKey))
          .map((d) => ({ t, d })),
      );

      if (toDelete.length === 0) {
        console.log("No matching devices found.");
        return;
      }

      await context.withinTransaction(() =>
        Promise.all(toDelete.map(({ t, d }) => t.deleteDevice(d))),
      );
      console.log(`Deleted ${toDelete.length} device(s).`);
    }
  }

  context.commands.registerCommand("device-manager.open", (_handle: unknown) => {
    openDialog().catch((err: unknown) => {
      console.error("Device Manager error:", err);
    });
  });

  void context.ui.registerContextMenuAction(
    "MidiTrack",
    "Manage Instances…",
    "device-manager.open",
  );
  void context.ui.registerContextMenuAction(
    "AudioTrack",
    "Manage Instances…",
    "device-manager.open",
  );
}
