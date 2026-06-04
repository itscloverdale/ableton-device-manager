# Device Manager

An [Ableton Live Extensions SDK](https://www.ableton.com) extension that lets you disable, enable, or delete every instance of a device across your entire project in one click.

## Usage

Right-click any **MIDI track** or **Audio track** and choose **Device Manager: Manage Instances…**

A dialog opens showing every device in the project with an instance count. Select a device, then:

- **Disable All** — turns off all instances of that device across every track
- **Enable All** — turns them all back on
- **Delete All** — removes all instances across every track

All actions are a single undo step (Cmd+Z).

The list supports:
- **Sorting** by name or instance count (click the column headers)
- **Search** to filter by name

## Installation

1. Download `Device-Manager-1.0.0.ablx` from the [Releases](../../releases) page
2. Double-click the `.ablx` file — Live will prompt you to install it
3. Make sure **Developer Mode is OFF** in `Preferences → Extensions`
4. Restart Live — the context menu item will appear automatically

> Requires Ableton Live 12 Beta (or later) with Extensions support.

## Building from source

**Prerequisites:** Node.js ≥ 24.14.1

```bash
git clone https://github.com/itscloverdale/manage-device-instances.git
cd manage-device-instances
npm install
npm run build      # compile
npm start          # load into Live for development
npm run package    # produce .ablx for distribution
```
