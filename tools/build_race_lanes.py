import argparse
import json
import math
import random
import sys
from pathlib import Path

import bpy
from mathutils import Vector


parser = argparse.ArgumentParser()
parser.add_argument("--map", choices=("city", "hill"), required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
city = args.map == "city"
source_scene = bpy.data.scenes["Cyber_City_Map_Studio" if city else "Hill_Kart_Map_Studio"]
source_root = bpy.data.objects["Cyber_City_Map" if city else "Hill_Kart_Map"]
bpy.context.window.scene = source_scene
centers = json.loads(source_root["track_centers_json"])
count = len(centers)
normals = []
for i in range(count):
    before, after = centers[(i - 1) % count], centers[(i + 1) % count]
    dx, dz = after[0] - before[0], after[1] - before[1]
    length = math.hypot(dx, dz)
    normals.append((-dz / length, dx / length))

road_prefixes = (
    "City four lane asphalt", "City lane dashes", "City road edge",
    "City concrete sidewalk", "City outer curb", "City concrete traffic barrier",
    "City blue barrier cap", "City alternating barrier bands", "City lane arrow",
    "City start checker", "City cyan racing edge", "City glowing sidewalk edge",
)
fixture_prefixes = (
    "Street light pole", "Street lamp arm", "Street lamp housing", "Street light lens",
    "Pavement drain frame", "Pavement drain grill", "Sidewalk expansion joint",
)
if city:
    source_objects = list(bpy.data.collections["Cyber_City_Source"].objects)
    fixtures = [obj for obj in source_objects if obj.name.startswith(fixture_prefixes)]
    environment = [obj for obj in source_objects if not obj.name.startswith(road_prefixes + fixture_prefixes)]
else:
    environment = list(bpy.data.collections["Hill_Kart_Environment"].objects)
    fixtures = []

export_scene = bpy.data.scenes.new("Configurable_Race_Map_Export")
export_collection = bpy.data.collections.new("Configurable_Race_Map")
export_scene.collection.children.link(export_collection)
root = bpy.data.objects.new("Cyber_City_Race_Map" if city else "Hill_Kart_Race_Map", None)
export_collection.objects.link(root)
for key in source_root.keys():
    root[key] = source_root[key]
root["available_lane_counts"] = [2, 3, 4, 5]
root["lane_width_m"] = 3.5
root["road_variants_from_blender"] = True


def point(index, offset=0.0, height=0.0):
    x, z = centers[index % count]
    nx, nz = normals[index % count]
    return (x + nx * offset, -z - nz * offset, height)


class Geometry:
    def __init__(self):
        self.groups = {}

    def group(self, material, category):
        return self.groups.setdefault((material.name, category), {
            "material": material, "vertices": [], "faces": [], "smooth": [],
            "colors": [], "color_name": None,
        })

    def add(self, vertices, faces, material, category, colors=None, color_name=None, smooth=False):
        group = self.group(material, category)
        base = len(group["vertices"])
        group["vertices"].extend(vertices)
        group["faces"].extend(tuple(base + index for index in face) for face in faces)
        group["smooth"].extend([smooth] * len(faces))
        group["colors"].extend(colors or [(1, 1, 1, 1)] * len(vertices))
        if color_name:
            group["color_name"] = color_name

    def ribbon(self, name, lo, hi, height, material, filter_fn=None, grain=False):
        vertices, faces, colors = [], [], []
        rng = random.Random(80417 if not city else 913708)
        color_name = next((node.layer_name for node in material.node_tree.nodes if node.type == "VERTEX_COLOR"), None)
        shade = (0.0343398, 0.0451862, 0.0466651) if city else (0.0612461, 0.0648033, 0.0544803)
        for i in range(count):
            if filter_fn and not filter_fn(i):
                continue
            j = (i + 1) % count
            base = len(vertices)
            vertices.extend([point(i, lo, height), point(i, hi, height), point(j, hi, height), point(j, lo, height)])
            faces.append((base, base + 1, base + 2, base + 3))
            if grain:
                for _ in range(4):
                    variation = rng.uniform(.89, 1.10)
                    colors.append((*[channel * variation for channel in shade], 1))
        self.add(vertices, faces, material, name, colors if grain else None, color_name if grain else None)

    def write(self, parent, prefix):
        for (material_name, category), group in self.groups.items():
            if not group["faces"]:
                continue
            mesh = bpy.data.meshes.new(prefix + " " + category + " " + material_name)
            mesh.from_pydata(group["vertices"], [], group["faces"])
            mesh.materials.append(group["material"])
            mesh.update()
            for polygon, smooth in zip(mesh.polygons, group["smooth"]):
                polygon.use_smooth = smooth
                if category in ("asphalt", "paint", "kerb", "sidewalk") and polygon.normal.z < 0:
                    polygon.flip()
            if group["color_name"]:
                attribute = mesh.color_attributes.new(name=group["color_name"], type="BYTE_COLOR", domain="POINT")
                for i, color in enumerate(group["colors"]):
                    attribute.data[i].color = color
            obj = bpy.data.objects.new(mesh.name, mesh)
            export_collection.objects.link(obj)
            obj.parent = parent
            obj["race_surface"] = category


# Cache source geometry once, keeping the original saved source and live editor untouched.
depsgraph = bpy.context.evaluated_depsgraph_get()


def source_parts(objects):
    parts = []
    for obj in objects:
        if obj.type not in {"MESH", "FONT", "CURVE"}:
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh(preserve_all_data_layers=True, depsgraph=depsgraph)
        if mesh is None:
            continue
        transform = obj.matrix_world
        for material_index, material in enumerate(mesh.materials):
            if material is None:
                continue
            polygons = [p for p in mesh.polygons if p.material_index == material_index]
            if not polygons:
                continue
            color_name = next((n.layer_name for n in material.node_tree.nodes if n.type == "VERTEX_COLOR"), None)
            attribute = mesh.color_attributes.get(color_name) if color_name else None
            vertices, faces, colors, smooth, used = [], [], [], [], {}
            for polygon in polygons:
                face = []
                for loop_index in polygon.loop_indices:
                    vertex_index = mesh.loops[loop_index].vertex_index
                    rgba = tuple(attribute.data[vertex_index if attribute.domain == "POINT" else loop_index].color) if attribute else (1, 1, 1, 1)
                    key = (vertex_index, rgba)
                    if key not in used:
                        used[key] = len(vertices)
                        vertices.append(tuple(transform @ mesh.vertices[vertex_index].co))
                        colors.append(rgba)
                    face.append(used[key])
                faces.append(tuple(face))
                smooth.append(polygon.use_smooth)
            parts.append({"vertices": vertices, "faces": faces, "material": material, "colors": colors, "color_name": color_name, "smooth": smooth})
        evaluated.to_mesh_clear()
    return parts


def append_parts(builder, parts, category, translation=(0, 0, 0)):
    tx, ty, tz = translation
    for part in parts:
        vertices = part["vertices"] if translation == (0, 0, 0) else [(x + tx, y + ty, z + tz) for x, y, z in part["vertices"]]
        group = builder.group(part["material"], category)
        base = len(group["vertices"])
        group["vertices"].extend(vertices)
        group["faces"].extend(tuple(base + i for i in face) for face in part["faces"])
        group["smooth"].extend(part["smooth"])
        group["colors"].extend(part["colors"])
        if part["color_name"]:
            group["color_name"] = part["color_name"]


static = Geometry()
append_parts(static, source_parts(environment), "environment")
static_root = bpy.data.objects.new("RaceEnvironment", None)
export_collection.objects.link(static_root)
static_root.parent = root
static.write(static_root, "CityMap" if city else "HillMap")
print("Merged static environment:", len(static.groups), "material batches", flush=True)
del static

fixture_parts = []
for obj in fixtures:
    parts = source_parts([obj])
    if not parts:
        continue
    vertices = [v for part in parts for v in part["vertices"]]
    x = sum(v[0] for v in vertices) / len(vertices)
    z = -sum(v[1] for v in vertices) / len(vertices)
    index = min(range(count), key=lambda i: (centers[i][0] - x) ** 2 + (centers[i][1] - z) ** 2)
    nx, nz = normals[index]
    side = 1 if (x - centers[index][0]) * nx + (z - centers[index][1]) * nz >= 0 else -1
    fixture_parts.append((parts, nx * side, -nz * side))

materials = {
    "asphalt": "City asphalt" if city else "Map studio asphalt",
    "paint": "City traffic white paint" if city else "Map road paint",
    "barrier": "City weathered concrete" if city else "Map sand barrier",
    "black": "City hazard charcoal" if city else "Map doors dark charcoal",
    "red": "City weathered concrete" if city else "Map curb red",
    "groove": "City hazard charcoal" if city else "Map guardrail recess",
}
if city:
    materials.update({"blue": "City traffic blue", "yellow": "City hazard yellow", "sidewalk": "City sidewalk concrete", "cyan": "City billboard cyan", "magenta": "City electric magenta"})
materials = {key: bpy.data.materials[name] for key, name in materials.items()}

for lanes in range(2, 6):
    half = lanes * 3.5 / 2
    road = Geometry()
    road.ribbon("asphalt", -half, half, 0, materials["asphalt"], grain=True)
    for lane in range(1, lanes):
        offset = -half + lane * 3.5
        road.ribbon("paint", offset - .055, offset + .055, .025, materials["paint"], lambda i: (i // 2) % 4 < 2)
    for side in (-1, 1):
        road.ribbon("paint", side * (half - .70), side * (half - .60), .029, materials["paint"])
        if city:
            road.ribbon("kerb", side * (half - .46), side * (half - .38), .037, materials["cyan"])
            road.ribbon("sidewalk", side * (half + .7), side * (half + 3.8), .12, materials["sidewalk"])
            road.ribbon("sidewalk", side * (half + 3.55), side * (half + 3.8), .19, materials["barrier"])
            road.ribbon("sidewalk", side * (half + 3.31), side * (half + 3.44), .145, materials["magenta"])
        else:
            road.ribbon("kerb", side * (half - .32), side * (half - .02), .042, materials["red"], lambda i: (i // 2) % 2 == 0)
            road.ribbon("kerb", side * (half - .32), side * (half - .02), .042, materials["paint"], lambda i: (i // 2) % 2 == 1)
        vertices, faces = [], []
        height = .82 if city else .9
        for i in range(count):
            j = (i + 1) % count
            base = len(vertices)
            vertices.extend([point(i, side * half, 0), point(j, side * half, 0), point(j, side * half, height), point(i, side * half, height), point(i, side * (half + .65), 0), point(j, side * (half + .65), 0), point(j, side * (half + .65), height), point(i, side * (half + .65), height)])
            faces.extend([(base, base + 1, base + 2, base + 3), (base + 4, base + 7, base + 6, base + 5), (base + 3, base + 2, base + 6, base + 7)])
        road.add(vertices, faces, materials["barrier"], "barrier")
        if city:
            road.ribbon("barrier", side * half, side * (half + .65), .835, materials["blue"])
            for material, parity in ((materials["yellow"], 0), (materials["black"], 1)):
                vertices, faces = [], []
                for i in range(count):
                    if (i // 3) % 2 != parity:
                        continue
                    base = len(vertices)
                    vertices.extend([point(i, side * (half - .005), .4), point(i + 1, side * (half - .005), .4), point(i + 1, side * (half - .005), .66), point(i, side * (half - .005), .66)])
                    faces.append((base, base + 1, base + 2, base + 3))
                road.add(vertices, faces, material, "barrier")
        else:
            vertices, faces = [], []
            for i in range(count):
                for h0, h1 in ((.22, .27), (.53, .58), (.83, .88)):
                    base = len(vertices)
                    vertices.extend([point(i, side * (half - .004), h0), point(i + 1, side * (half - .004), h0), point(i + 1, side * (half - .004), h1), point(i, side * (half - .004), h1)])
                    faces.append((base, base + 1, base + 2, base + 3))
            road.add(vertices, faces, materials["groove"], "barrier")
    arrow_indices = range(0, count, 70) if city else (60, 145, 225, 300, 390, 615, 760)
    for index in arrow_indices:
        nx, nz = normals[index]
        tx, tz = nz, -nx
        x, z = centers[index]
        for lane in range(lanes):
            offset = -half + (lane + .5) * 3.5
            shape = [(-.15, -1.6), (.15, -1.6), (.15, .2), (.65, .2), (0, 1.4), (-.65, .2), (-.15, .2)]
            vertices = [(x + nx * (offset + u) + tx * v, -z - nz * (offset + u) - tz * v, .04) for u, v in shape]
            road.add(vertices, [tuple(range(len(shape)))], materials["paint"], "paint")
    nx, nz = normals[0]
    tx, tz = nz, -nx
    x, z = centers[0]
    columns = lanes * 4
    inner_half = half - .5
    for row in range(3):
        for column in range(columns):
            vertices = []
            for u, v in ((0, 0), (1, 0), (1, 1), (0, 1)):
                offset = -inner_half + (column + u) * inner_half * 2 / columns
                distance = -1.5 + row + v
                vertices.append((x + nx * offset + tx * distance, -z - nz * offset - tz * distance, .05))
            road.add(vertices, [(0, 1, 2, 3)], materials["paint"] if (row + column) % 2 else materials["black"], "paint")
    for parts, dx, dy in fixture_parts:
        append_parts(road, parts, "fixtures", (dx * (half - 7), dy * (half - 7), 0))
    lane_root = bpy.data.objects.new("RaceLanes_" + str(lanes), None)
    export_collection.objects.link(lane_root)
    lane_root.parent = root
    lane_root["race_lane_count"] = lanes
    lane_root["track_width_m"] = half * 2
    lane_root["lane_width_m"] = 3.5
    road.write(lane_root, ("City" if city else "Hill") + " Lanes " + str(lanes))
    print("Built Blender lane variant:", lanes, "width:", half * 2, "batches:", len(road.groups), flush=True)

bpy.context.window.scene = export_scene
for obj in export_scene.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
formats = [item.identifier for item in bpy.ops.export_scene.gltf.get_rna_type().properties["export_format"].enum_items]
assert "GLB" in formats
assert args.output.parent.is_dir()
bpy.ops.export_scene.gltf(filepath=str(args.output), export_format="GLB", use_selection=True, use_active_scene=True, export_apply=True, export_extras=True, export_yup=True, export_cameras=False, export_lights=False)
print("Exported configurable Blender map:", args.output, args.output.stat().st_size, flush=True)
