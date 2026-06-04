import {
  initialize,
  DrumRack,
  Simpler,
  Track,
  Chain,
  MidiTrack,
  DataModelObject,
  Device,
  type ActivationContext,
  type Handle,
} from "@ableton-extensions/sdk";
import dialogHtml from "./dialog.html";

const DEVICE_ON_PARAM = "Device On";

// ── Tree data types (serialised into the dialog HTML) ──────────────────────

interface TreeDevice {
  displayName: string;
  typeKey: string;
  deviceHandleId: string;
  trackHandleId: string;
}

interface TreeTrack {
  name: string;
  kind: "group" | "midi" | "audio" | "return" | "main";
  devices: TreeDevice[];
  children: TreeTrack[];
}

interface TreeData {
  tracks: TreeTrack[];
  returnTracks: TreeTrack[];
  mainTrack: TreeTrack;
}

type Action =
  | "disable" | "enable" | "delete"
  | "disable-all" | "enable-all" | "delete-all"
  | "cancel";

interface DialogResult {
  action: Action;
  deviceHandleId?: string;
  trackHandleId?: string;
  typeKey?: string;
}

// ── Device identity helpers ────────────────────────────────────────────────

function getDeviceIdentity(device: Device<"1.0.0">): {
  displayName: string;
  typeKey: string;
} {
  if (device instanceof DrumRack) {
    return { displayName: "Drum Rack", typeKey: "instanceof:DrumRack" };
  }
  if (device instanceof Simpler) {
    return { displayName: "Simpler", typeKey: "instanceof:Simpler" };
  }
  return { displayName: device.name, typeKey: `name:${device.name}` };
}

function matchesTypeKey(device: Device<"1.0.0">, typeKey: string): boolean {
  if (typeKey === "instanceof:DrumRack") return device instanceof DrumRack;
  if (typeKey === "instanceof:Simpler") return device instanceof Simpler;
  if (typeKey.startsWith("name:")) {
    return device.name === typeKey.slice(5) && !(device instanceof DrumRack);
  }
  return false;
}

// ── Tree builder ───────────────────────────────────────────────────────────

function buildTrackNode(
  track: Track<"1.0.0">,
  kind: TreeTrack["kind"],
  allTracks: Track<"1.0.0">[],
  groupTrackIds: Set<string>,
): TreeTrack {
  const trackId = track.handle.id.toString();

  const children: TreeTrack[] =
    kind === "group"
      ? allTracks
          .filter((t) => {
            const gt = t.groupTrack;
            return gt !== null && gt.handle.id.toString() === trackId;
          })
          .map((child) => {
            const childId = child.handle.id.toString();
            const childKind: TreeTrack["kind"] = groupTrackIds.has(childId)
              ? "group"
              : child instanceof MidiTrack
              ? "midi"
              : "audio";
            return buildTrackNode(child, childKind, allTracks, groupTrackIds);
          })
      : [];

  return {
    name: track.name,
    kind,
    devices: track.devices.map((d) => {
      const { displayName, typeKey } = getDeviceIdentity(d);
      return {
        displayName,
        typeKey,
        deviceHandleId: d.handle.id.toString(),
        trackHandleId: trackId,
      };
    }),
    children,
  };
}

// ── activate ───────────────────────────────────────────────────────────────

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  // ── Dialog ──────────────────────────────────────────────────────────────

  async function openDialog(): Promise<void> {
    const song = context.application.song;
    const allTracks = [...song.tracks];

    // Identify which tracks are group tracks (i.e. other tracks list them as parent)
    const groupTrackIds = new Set<string>();
    for (const t of allTracks) {
      const gt = t.groupTrack;
      if (gt !== null) groupTrackIds.add(gt.handle.id.toString());
    }

    const topLevel = allTracks.filter((t) => t.groupTrack === null);
    const tracks = topLevel.map((t) => {
      const id = t.handle.id.toString();
      const kind: TreeTrack["kind"] = groupTrackIds.has(id)
        ? "group"
        : t instanceof MidiTrack
        ? "midi"
        : "audio";
      return buildTrackNode(t, kind, allTracks, groupTrackIds);
    });

    const returnTracks = song.returnTracks.map((t) =>
      buildTrackNode(t, "return", [], new Set()),
    );
    const mainTrack = buildTrackNode(song.mainTrack, "main", [], new Set());

    const treeData: TreeData = { tracks, returnTracks, mainTrack };

    // Build lookup maps so we can resolve handles after the dialog closes
    const deviceMap = new Map<string, Device<"1.0.0">>();
    const trackMap = new Map<string, Track<"1.0.0">>();

    const allTracksForCache = [
      ...allTracks,
      ...song.returnTracks,
      song.mainTrack,
    ];
    for (const t of allTracksForCache) {
      trackMap.set(t.handle.id.toString(), t);
      for (const d of t.devices) {
        deviceMap.set(d.handle.id.toString(), d);
      }
    }

    const html = dialogHtml.replace("__TREE_DATA__", JSON.stringify(treeData));

    let result: DialogResult;
    try {
      const raw = await context.ui.showModalDialog(
        `data:text/html,${encodeURIComponent(html)}`,
        640,
        520,
      );
      result = JSON.parse(raw) as DialogResult;
    } catch {
      return;
    }

    if (result.action === "cancel") return;

    // ── Single-device actions ──────────────────────────────────────────────
    if (
      result.action === "disable" ||
      result.action === "enable" ||
      result.action === "delete"
    ) {
      if (!result.deviceHandleId) return;
      const device = deviceMap.get(result.deviceHandleId);
      if (!device) return;

      if (result.action === "disable" || result.action === "enable") {
        const enabled = result.action === "enable";
        const param = device.parameters.find((p) => p.name === DEVICE_ON_PARAM);
        if (!param) {
          console.warn(`"${DEVICE_ON_PARAM}" not found. Parameters: ${device.parameters.map((p) => p.name).join(", ")}`);
          return;
        }
        await context.withinTransaction(() => param.setValue(enabled ? 1 : 0));
        console.log(`${enabled ? "Enabled" : "Disabled"} "${device.name}".`);
      }

      if (result.action === "delete") {
        if (!result.trackHandleId) return;
        const track = trackMap.get(result.trackHandleId);
        if (!track) return;
        await context.withinTransaction(() => track.deleteDevice(device));
        console.log(`Deleted "${device.name}".`);
      }
      return;
    }

    // ── Bulk actions ───────────────────────────────────────────────────────
    if (!result.typeKey) return;
    const { typeKey } = result;

    const allTracksForBulk = [
      ...allTracks,
      ...song.returnTracks,
      song.mainTrack,
    ];

    if (result.action === "disable-all" || result.action === "enable-all") {
      const enabled = result.action === "enable-all";
      const targetParams = allTracksForBulk.flatMap((t) =>
        t.devices
          .filter((d) => matchesTypeKey(d, typeKey))
          .flatMap((d) => {
            const param = d.parameters.find((p) => p.name === DEVICE_ON_PARAM);
            if (!param) {
              console.warn(`"${DEVICE_ON_PARAM}" not found on device in "${t.name}".`);
              return [];
            }
            return [param];
          }),
      );
      if (targetParams.length === 0) { console.log("No matching devices."); return; }
      await context.withinTransaction(() =>
        Promise.all(targetParams.map((p) => p.setValue(enabled ? 1 : 0))),
      );
      console.log(`${enabled ? "Enabled" : "Disabled"} ${targetParams.length} device(s).`);
    }

    if (result.action === "delete-all") {
      const toDelete = allTracksForBulk.flatMap((t) =>
        t.devices.filter((d) => matchesTypeKey(d, typeKey)).map((d) => ({ t, d })),
      );
      if (toDelete.length === 0) { console.log("No matching devices."); return; }
      await context.withinTransaction(() =>
        Promise.all(toDelete.map(({ t, d }) => t.deleteDevice(d))),
      );
      console.log(`Deleted ${toDelete.length} device(s).`);
    }
  }

  context.commands.registerCommand("device-manager.open", (_handle: unknown) => {
    openDialog().catch((err: unknown) => console.error("Device Manager error:", err));
  });

  void context.ui.registerContextMenuAction("MidiTrack", "Manage Instances…", "device-manager.open");
  void context.ui.registerContextMenuAction("AudioTrack", "Manage Instances…", "device-manager.open");

  // ── Context menu: right-click directly on DrumRack or Simpler ─────────────
  // These are the only two device types that have a context menu scope in the SDK.

  async function deviceContextAction(
    handle: Handle,
    action: "disable" | "enable" | "delete",
  ): Promise<void> {
    const device = context.getObjectFromHandle(handle, Device);

    if (action === "disable" || action === "enable") {
      const enabled = action === "enable";
      const param = device.parameters.find((p) => p.name === DEVICE_ON_PARAM);
      if (!param) {
        console.warn(`"${DEVICE_ON_PARAM}" not found. Parameters: ${device.parameters.map((p) => p.name).join(", ")}`);
        return;
      }
      await context.withinTransaction(() => param.setValue(enabled ? 1 : 0));
      console.log(`${enabled ? "Enabled" : "Disabled"} "${device.name}".`);
    }

    if (action === "delete") {
      const parent = device.parent;
      if (!parent) return;
      const parentObj = context.getObjectFromHandle(parent.handle, DataModelObject);
      if (parentObj instanceof Track) {
        await context.withinTransaction(() => parentObj.deleteDevice(device));
      } else if (parentObj instanceof Chain) {
        await context.withinTransaction(() => parentObj.deleteDevice(device));
      }
      console.log(`Deleted "${device.name}".`);
    }
  }

  for (const scope of ["DrumRack", "Simpler"] as const) {
    for (const action of ["disable", "enable", "delete"] as const) {
      const cmdId = `device-manager.ctx-${scope.toLowerCase()}-${action}`;
      const label =
        action === "disable" ? "Disable Device"
        : action === "enable" ? "Enable Device"
        : "Delete Device";

      context.commands.registerCommand(cmdId, (handle: unknown) => {
        deviceContextAction(handle as Handle, action).catch((err: unknown) =>
          console.error(`Device context action error:`, err),
        );
      });

      void context.ui.registerContextMenuAction(scope, label, cmdId);
    }
  }
}
