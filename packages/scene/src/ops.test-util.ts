import { composition, nullLayer, type Obj, project, visual } from "./fixtures.test-util.js";
import { createSceneState, type Project, ProjectSchema } from "./index.js";

export const omitId = (o: Obj): Obj =>
  Object.fromEntries(Object.entries(o).filter(([k]) => k !== "id"));

export const solid = (id: string): Obj => ({
  ...visual(id),
  type: "solid",
  width: 100,
  height: 100,
  color: "#ff0000",
});

/** main: a (null), b (child of a), c (null). */
export const baseDoc = (): Project =>
  ProjectSchema.parse(
    project({
      compositions: [composition("main", [nullLayer("a"), nullLayer("b", "a"), nullLayer("c")])],
    }),
  );

export const baseState = () => createSceneState(baseDoc());

export const layerIds = (doc: Project): string[] =>
  (doc.compositions[0]?.layers ?? []).map((l) => l.id);
