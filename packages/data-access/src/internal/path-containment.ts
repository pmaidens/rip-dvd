import { isAbsolute, relative, sep } from "node:path";

export function isPathWithinDirectory(
  directoryPath: string,
  candidatePath: string,
): boolean {
  const pathFromDirectory = relative(directoryPath, candidatePath);
  return (
    pathFromDirectory !== "" &&
    pathFromDirectory !== ".." &&
    !pathFromDirectory.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromDirectory)
  );
}
