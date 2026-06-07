/**
 * WebUSB driver for ESC/POS thermal printers.
 *
 * Most TM-T20/T82 and clones expose a vendor-specific interface (class 7 = printer)
 * with a single bulk-OUT endpoint. We let the user pair the device once via
 * `navigator.usb.requestDevice` with permissive filters, then store nothing —
 * the browser remembers granted devices per origin.
 */

type USBDevice = unknown;
interface USB {
  requestDevice: (opts: { filters: Array<{ classCode?: number; vendorId?: number }> }) => Promise<USBDeviceLike>;
  getDevices: () => Promise<USBDeviceLike[]>;
}
interface USBInterfaceLike {
  alternate: { endpoints: Array<{ endpointNumber: number; direction: 'in' | 'out' }> };
  interfaceNumber: number;
}
interface USBConfigurationLike {
  configurationValue: number;
  interfaces: USBInterfaceLike[];
}
interface USBDeviceLike {
  productName?: string;
  manufacturerName?: string;
  open: () => Promise<void>;
  close: () => Promise<void>;
  selectConfiguration: (value: number) => Promise<void>;
  claimInterface: (n: number) => Promise<void>;
  releaseInterface: (n: number) => Promise<void>;
  configuration: USBConfigurationLike | null;
  configurations: USBConfigurationLike[];
  transferOut: (endpoint: number, data: BufferSource) => Promise<{ status: string }>;
}

interface ReadyDevice {
  device: USBDeviceLike;
  interfaceNumber: number;
  endpointOut: number;
}

function getUSB(): USB | null {
  if (typeof navigator === 'undefined') return null;
  const nav = navigator as unknown as { usb?: USB };
  return nav.usb ?? null;
}

export function isWebUsbSupported(): boolean {
  return getUSB() !== null;
}

async function prepare(device: USBDeviceLike): Promise<ReadyDevice> {
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }
  const cfg = device.configuration ?? device.configurations[0];
  if (!cfg) throw new Error('printer_no_configuration');

  const iface = cfg.interfaces.find((i) =>
    i.alternate.endpoints.some((e) => e.direction === 'out'),
  );
  if (!iface) throw new Error('printer_no_out_interface');
  const endpoint = iface.alternate.endpoints.find((e) => e.direction === 'out');
  if (!endpoint) throw new Error('printer_no_out_endpoint');

  await device.claimInterface(iface.interfaceNumber);
  return {
    device,
    interfaceNumber: iface.interfaceNumber,
    endpointOut: endpoint.endpointNumber,
  };
}

/** Prompt the user to pair a printer. Browser remembers granted devices. */
export async function pairPrinter(): Promise<ReadyDevice> {
  const usb = getUSB();
  if (!usb) throw new Error('webusb_unsupported');
  const device = await usb.requestDevice({
    filters: [
      { classCode: 7 }, // USB printer class
      { vendorId: 0x04b8 }, // Epson
      { vendorId: 0x0483 }, // STM (some clones)
      { vendorId: 0x0fe6 }, // ICS Advent
      { vendorId: 0x1659 }, // Prolific
    ],
  });
  return prepare(device);
}

/** Use a previously-granted device, returns null if none paired. */
export async function getPairedPrinter(): Promise<ReadyDevice | null> {
  const usb = getUSB();
  if (!usb) return null;
  const devices = await usb.getDevices();
  if (!devices.length) return null;
  return prepare(devices[0]!);
}

export async function printBytes(target: ReadyDevice, data: Uint8Array): Promise<void> {
  // ESC/POS printers accept fairly large bulk chunks. We still split at 4KB to
  // play nice with slower controllers.
  const chunk = 4096;
  for (let i = 0; i < data.length; i += chunk) {
    await target.device.transferOut(target.endpointOut, data.slice(i, i + chunk));
  }
}

export async function disconnectPrinter(target: ReadyDevice): Promise<void> {
  try {
    await target.device.releaseInterface(target.interfaceNumber);
  } catch {
    // ignore
  }
  try {
    await target.device.close();
  } catch {
    // ignore
  }
}

// Re-export USB device type for callers that want to display the name
export type PairedPrinter = ReadyDevice;
