export function normalizeOpticalHardwareText(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

export function flattenBlockDeviceGraph(
  value,
  { maxDevices, source = "block-device discovery" },
) {
  if (!Array.isArray(value)) {
    throw new Error(`${source} output does not contain a blockdevices array`);
  }
  const pending = [...value];
  const records = [];
  while (pending.length > 0) {
    if (records.length >= maxDevices) {
      throw new Error(`${source} output exceeds ${maxDevices} devices`);
    }
    const item = pending.shift();
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${source} output contains a malformed block-device node`);
    }
    records.push(item);
    if (item.children !== undefined) {
      if (!Array.isArray(item.children)) {
        throw new Error(`${source} output contains malformed children`);
      }
      pending.push(...item.children);
    }
  }
  return records;
}

export function isVirtualQemuOpticalDevice({ model, vendor }) {
  const normalizedVendor = (normalizeOpticalHardwareText(vendor) ?? "")
    .replaceAll("_", " ")
    .toLowerCase();
  const normalizedModel = (normalizeOpticalHardwareText(model) ?? "")
    .replaceAll("_", " ")
    .toLowerCase();
  return normalizedVendor === "qemu" || normalizedModel.startsWith("qemu ");
}
