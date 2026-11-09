export type EngravedPalette = {
  background: {
    start: string;
    end: string;
    light: string;
    wash: string;
  };
  engraving: {
    shadow: string;
    highlight: string;
  };
};

export const mistPalette: EngravedPalette = {
  background: {
    start: "#e6edf3",
    end: "#e8e3ef",
    light: "#f0f4f8",
    wash: "#dcd9eb",
  },
  engraving: { shadow: "#66718b", highlight: "#fafbfe" },
};

export const sandPalette: EngravedPalette = {
  background: {
    start: "#f0e9e1",
    end: "#eddfdf",
    light: "#f7f1e9",
    wash: "#e9d7d9",
  },
  engraving: { shadow: "#8c6879", highlight: "#fdfafb" },
};

export const icePalette: EngravedPalette = {
  background: {
    start: "#e9eef8",
    end: "#dce5f7",
    light: "#f4f7fc",
    wash: "#d0ddf3",
  },
  engraving: { shadow: "#637b9b", highlight: "#f8faff" },
};
