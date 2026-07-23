import { describe, expect, it } from "vitest";
import { MAP_HEIGHT, MAP_WIDTH, project } from "../geoProject.js";

describe("project (equirectangular)", () => {
  it("maps the origin to the map center", () => {
    expect(project(0, 0)).toEqual({ x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 });
  });

  it("maps the north-west corner to (0, 0)", () => {
    expect(project(90, -180)).toEqual({ x: 0, y: 0 });
  });

  it("maps the south-east corner to (MAP_WIDTH, MAP_HEIGHT)", () => {
    expect(project(-90, 180)).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });
});
