import type { SelectionPolicy } from "@types";

export const manualSelectionPolicy: SelectionPolicy = {
  id: "manual",
  select: () => null,
};
