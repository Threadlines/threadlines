export function shouldOpenProjectFolderPickerImmediately(input: {
  isElectron: boolean;
}): boolean {
  return input.isElectron;
}
