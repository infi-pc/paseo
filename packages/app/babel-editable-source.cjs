const path = require("node:path");

const appSource = path.join(__dirname, "src");
const primitives = new Set([
  "View",
  "Text",
  "Pressable",
  "TextInput",
  "ScrollView",
  "Image",
  "ImageBackground",
  "TouchableOpacity",
  "TouchableHighlight",
  "TouchableWithoutFeedback",
]);

module.exports = function editableSource({ types: t }) {
  const enabled = process.env.PASEO_EDITABLE_SOURCE_MAP !== "0";
  return {
    name: "paseo-editable-source",
    visitor: {
      Program(program, { file }) {
        if (!enabled || file.opts.caller?.platform !== "web" || !file.opts.filename) return;
        const relative = path.relative(appSource, file.opts.filename);
        if (relative.startsWith("..") || path.isAbsolute(relative) || !relative) return;
        const source = "packages/app/src/" + relative.split(path.sep).join("/");

        // Read the original import bindings before Expo and Unistyles remap primitives.
        program.traverse({
          JSXOpeningElement(element) {
            const { name, loc, attributes } = element.node;
            if (!t.isJSXIdentifier(name) || !loc) return;
            const intrinsic = /^[a-z]/.test(name.name);
            if (!intrinsic) {
              const binding = element.scope.getBinding(name.name)?.path;
              if (
                !binding?.isImportSpecifier() ||
                !t.isIdentifier(binding.node.imported) ||
                !primitives.has(binding.node.imported.name) ||
                !["react-native", "react-native-web"].includes(binding.parent.source.value)
              )
                return;
            }

            const owner = element.findParent((parent) => {
              if (!parent.isFunction()) return false;
              const id = parent.node.id ?? parent.parentPath.node.id;
              return t.isIdentifier(id) && /^[A-Z]/.test(id.name);
            });
            const component = owner && (owner.node.id ?? owner.parentPath.node.id).name;
            const location = `${source}:${loc.start.line}:${loc.start.column + 1}`;
            if (intrinsic) {
              attributes.push(
                t.jsxAttribute(t.jsxIdentifier("data-ed-src"), t.stringLiteral(location)),
              );
              if (component) {
                attributes.push(
                  t.jsxAttribute(t.jsxIdentifier("data-ed-comp"), t.stringLiteral(component)),
                );
              }
              return;
            }

            const dataSetIndex = attributes.findLastIndex(
              (attribute) => t.isJSXAttribute(attribute) && attribute.name.name === "dataSet",
            );
            // Keep JSX precedence: any later spread can intentionally replace the dataset.
            const existing = attributes[dataSetIndex];
            const dataSet = t.objectExpression([
              ...(t.isJSXExpressionContainer(existing?.value) &&
              t.isExpression(existing.value.expression)
                ? [t.spreadElement(existing.value.expression)]
                : []),
              t.objectProperty(t.identifier("edSrc"), t.stringLiteral(location)),
              ...(component
                ? [t.objectProperty(t.identifier("edComp"), t.stringLiteral(component))]
                : []),
            ]);
            const attribute = t.jsxAttribute(
              t.jsxIdentifier("dataSet"),
              t.jsxExpressionContainer(dataSet),
            );
            if (existing) attributes[dataSetIndex] = attribute;
            else attributes.unshift(attribute);
          },
        });
      },
    },
  };
};
