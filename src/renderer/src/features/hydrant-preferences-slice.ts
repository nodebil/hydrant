import { createSlice } from "@reduxjs/toolkit";
import type { PayloadAction } from "@reduxjs/toolkit";
import { DEFAULT_HYDRANT_PREFERENCES } from "@shared";
import type { HydrantPreferences } from "@types";

export interface HydrantPreferencesState {
  value: HydrantPreferences;
}

const initialState: HydrantPreferencesState = {
  value: DEFAULT_HYDRANT_PREFERENCES,
};

export const hydrantPreferencesSlice = createSlice({
  name: "hydrantPreferences",
  initialState,
  reducers: {
    setHydrantPreferences: (
      state,
      action: PayloadAction<HydrantPreferences>
    ) => {
      state.value = action.payload;
    },
  },
});

export const { setHydrantPreferences } = hydrantPreferencesSlice.actions;
