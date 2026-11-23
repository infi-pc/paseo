module.exports = function (api) {
  api.cache.using(() => process.env.PASEO_EDITABLE_SOURCE_MAP !== "0"); // FORK(editable): invalidate transforms when source stamping changes.

  const expoPreset = [
    "babel-preset-expo",
    {
      // Transform `import.meta` for ALL platforms (web + native)
      // Required for modern ESM deps like Zustand 5 that use import.meta.env
      unstable_transformImportMeta: true,
    },
  ];

  return {
    presets: [expoPreset],
    plugins: [
      require("./babel-editable-source.cjs"), // FORK(editable): stamp source locations in web builds.
      [
        "react-native-unistyles/plugin",
        {
          root: "src",
        },
      ],
    ],
  };
};
