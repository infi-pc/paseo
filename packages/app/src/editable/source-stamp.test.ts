import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { transformSync } = require("@babel/core");
const plugin = require("../../babel-editable-source.cjs");
const filename = fileURLToPath(new URL("./StampFixture.tsx", import.meta.url));
const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const babelConfig = fileURLToPath(new URL("../../babel.config.js", import.meta.url));
const fixture = [
  'import { View as Box, Text } from "react-native";',
  'import { StyleSheet } from "react-native-unistyles";',
  "const styles = StyleSheet.create((theme) => ({ body: { color: theme.colors.foreground } }));",
  'const WorkspaceHeader = (props: object) => <><Box {...props} dataSet={{ keep: "yes" }} style={styles.body}><Text>Text</Text><span {...props} /></Box></>;',
].join("\n");

function transform(platform: string) {
  return transformSync(fixture, {
    root: appRoot,
    cwd: appRoot,
    filename,
    configFile: babelConfig,
    caller: { name: "metro", bundler: "metro", platform },
  })?.code;
}

afterEach(() => vi.unstubAllEnvs());

describe("Editable JSX source stamping", () => {
  it("composes with the real Expo and Unistyles transforms on web", () => {
    vi.stubEnv("NODE_ENV", "production");
    const result = transform("web");
    expect(result).toContain("packages/app/src/editable/StampFixture.tsx:4:46");
    expect(result).toContain("edComp:");
    expect(result).toContain("WorkspaceHeader");
    expect(result).toContain('"data-ed-src"');
    expect(result).toMatch(/keep:\s*"yes"/);
    expect(result).toContain("react-native-unistyles/components/native/View");
  });

  it.each(["ios", "android"])("keeps JSX source attributes out of %s bundles", (platform) => {
    vi.stubEnv("NODE_ENV", "production");
    const result = transform(platform);
    vi.stubEnv("PASEO_EDITABLE_SOURCE_MAP", "0");
    expect(transform(platform)).toBe(result);
    expect(result).not.toMatch(/data-ed-src|edSrc|edComp/);
    expect(result).toContain("dataSet");
  });

  it("respects the build-time opt-out", () => {
    vi.stubEnv("PASEO_EDITABLE_SOURCE_MAP", "0");
    expect(transform("web")).not.toMatch(/data-ed-src|edSrc|edComp/);
  });

  it("renders RNW datasets and intrinsic attributes as DOM stamps", () => {
    const source = [
      'import { View, Text } from "react-native";',
      'const Header = (props) => <View {...props}><Text dataSet={{ keep: "yes" }} /><span /></View>;',
    ].join("\n");
    const { code } = transformSync(source, {
      filename,
      configFile: false,
      babelrc: false,
      caller: { name: "metro", platform: "web" },
      plugins: [
        plugin,
        require("@babel/plugin-transform-react-jsx"),
        require("@babel/plugin-transform-modules-commonjs"),
      ],
    });
    const reactNativeWeb = require("react-native-web");
    const Header = new Function("React", "require", code + "\nreturn Header;")(
      { createElement },
      () => reactNativeWeb,
    );
    const html = renderToStaticMarkup(createElement(Header, { testID: "target" }));
    expect(html).toContain('data-testid="target"');
    expect(html.match(/data-ed-src=/g)).toHaveLength(3);
    expect(html.match(/data-ed-comp="Header"/g)).toHaveLength(3);
    expect(html).toContain('data-keep="yes"');
  });
});
