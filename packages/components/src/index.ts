export { background, kineticType, logoReveal, lowerThird, transition } from "./built-in/index.js";
export { compileComponentProgram } from "./custom/compile.js";
export {
  type ComponentDefinitionInput,
  ComponentDefinitionInputSchema,
  type ComponentDefinitionSummary,
  ComponentDefinitionSummarySchema,
  type ComponentProjectDefinition,
  ComponentProjectDefinitionSchema,
  MAX_PROJECT_COMPONENT_DEFINITIONS,
  ProjectComponentIdSchema,
} from "./custom/definition.js";
export {
  createProjectComponentRegistry,
  type RenderComponentDefinition,
} from "./custom/registry.js";
export { COMPONENT_PROGRAM_LIMITS } from "./custom/runtime.js";
export {
  type ComponentDefinition,
  type ComponentEvalContext,
  type ComponentOutput,
  defineComponent,
  type ResolvedProps,
} from "./define.js";
export { createComponentHost } from "./host.js";
export {
  type ColorValue,
  ColorValueSchema,
  MAX_NUMBER,
  MAX_POINT,
  MAX_PROPS_PER_COMPONENT,
  PROP_NAME_PATTERN,
  type PropDescriptor,
  PropDescriptorSchema,
  type PropType,
} from "./props.js";
export {
  BUILT_IN_COMPONENTS,
  builtInRegistry,
  type ComponentRegistry,
  createComponentRegistry,
} from "./registry.js";
export { ComponentPropError, type ResolveEnv, resolveProps } from "./resolve-props.js";
export { type ComponentStyle, createComponentStyle } from "./style.js";
