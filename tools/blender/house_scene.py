# Dựng cảnh nhà có điện mặt trời bằng Blender (bpy) rồi render ảnh ngày/đêm cho app INSOLAR Monitor.
# Chạy: python3.11 house_scene.py <ảnh mặt trước pin.png> <thư mục ra> [ngày|đêm|cả hai] [số mẫu]
# Xuất: house_day.png, house_night.png (nền trong suốt phía trên đường chân trời) và anchors.json
# (toạ độ 2D các điểm để app vẽ đường năng lượng chạy chồng lên ảnh).
import bpy, bmesh, math, json, sys, os
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view

ESS_TEX, OUT = sys.argv[-4], sys.argv[-3]
WHICH, SAMPLES = sys.argv[-2], int(sys.argv[-1])
RES = tuple(int(x) for x in os.environ.get("RES", "1260x1098").split("x"))
os.makedirs(OUT, exist_ok=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


# ---------------- vật liệu ----------------
def mat(name, color, rough=0.6, metal=0.0, coat=0.0, emit=None, estr=0.0, trans=0.0, ior=1.45):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Transmission Weight"].default_value = trans
    b.inputs["IOR"].default_value = ior
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1)
        b.inputs["Emission Strength"].default_value = estr
    return m


def mat_noise(name, c1, c2, scale=6.0, rough=0.8, detail=6.0):
    """Màu loang (cỏ, bê tông, nhựa đường)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = rough
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].color = (*c1, 1)
    r.color_ramp.elements[1].color = (*c2, 1)
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    return m


def mat_panel():
    """Tấm pin: kính xanh đậm, lưới cell bạc (Brick texture)."""
    m = bpy.data.materials.new("pv")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = 0.12
    b.inputs["Coat Weight"].default_value = 1.0
    br = nt.nodes.new("ShaderNodeTexBrick")
    br.inputs["Color1"].default_value = (0.02, 0.05, 0.16, 1)
    br.inputs["Color2"].default_value = (0.03, 0.07, 0.2, 1)
    br.inputs["Mortar"].default_value = (0.55, 0.6, 0.68, 1)
    br.inputs["Scale"].default_value = 9.0
    br.inputs["Mortar Size"].default_value = 0.012
    br.inputs["Brick Width"].default_value = 0.5
    br.inputs["Row Height"].default_value = 0.25
    br.offset = 0.0
    tc = nt.nodes.new("ShaderNodeTexCoord")
    nt.links.new(tc.outputs["Object"], br.inputs["Vector"])
    nt.links.new(br.outputs["Color"], b.inputs["Base Color"])
    return m


def mat_image(name, path):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = 0.25
    b.inputs["Coat Weight"].default_value = 0.6
    t = nt.nodes.new("ShaderNodeTexImage")
    t.image = bpy.data.images.load(path)
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    return m


def mat_wood():
    m = bpy.data.materials.new("wood")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    b.inputs["Roughness"].default_value = 0.55
    w = nt.nodes.new("ShaderNodeTexWave")
    w.inputs["Scale"].default_value = 2.5
    w.inputs["Distortion"].default_value = 4
    r = nt.nodes.new("ShaderNodeValToRGB")
    r.color_ramp.elements[0].color = (0.32, 0.17, 0.08, 1)
    r.color_ramp.elements[1].color = (0.55, 0.33, 0.17, 1)
    nt.links.new(w.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    return m


# ---------------- hình khối ----------------
def link(o):
    bpy.context.scene.collection.objects.link(o)
    return o


def box(name, mn, mx, m, bevel=0.0, seg=2):
    (x0, y0, z0), (x1, y1, z1) = mn, mx
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    f = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(v, [], f)
    me.update()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(m)
    if bevel:
        bv = o.modifiers.new("bv", "BEVEL")
        bv.width = bevel
        bv.segments = seg
        bv.limit_method = "ANGLE"
    return o


def quad_slab(name, pts, thick, m):
    me = bpy.data.meshes.new(name)
    me.from_pydata(pts, [], [tuple(range(len(pts)))])
    me.update()
    o = link(bpy.data.objects.new(name, me))
    o.data.materials.append(m)
    s = o.modifiers.new("s", "SOLIDIFY")
    s.thickness = thick
    s.offset = 1
    return o


def cyl(name, r, h, loc, m, rot=(0, 0, 0), verts=24):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(m)
    bpy.ops.object.shade_smooth()
    return o


def blob(name, loc, size, m, seed=0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = size
    o.data.materials.append(m)
    tex = bpy.data.textures.new(name + "t", "CLOUDS")
    tex.noise_scale = 0.55
    d = o.modifiers.new("d", "DISPLACE")
    d.texture = tex
    d.strength = 0.28
    d.texture_coords = "GLOBAL"
    bpy.ops.object.shade_smooth()
    return o


def tree(x, y, s, mt, mf, mf2):
    cyl("trunk", 0.14 * s, 2.0 * s, (x, y, 1.0 * s), mt, verts=12)
    blob("leaf", (x, y, 2.9 * s), (1.35 * s, 1.35 * s, 1.55 * s), mf)
    blob("leaf2", (x - 0.4 * s, y - 0.3 * s, 3.5 * s), (0.85 * s, 0.85 * s, 0.9 * s), mf2)


def wire(name, p0, p1, sag, m, r=0.018):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = r
    sp = cu.splines.new("POLY")
    pts = []
    for i in range(17):
        t = i / 16
        p = Vector(p0).lerp(Vector(p1), t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    sp.points.add(len(pts) - 1)
    for i, p in enumerate(pts):
        sp.points[i].co = (*p, 1)
    o = link(bpy.data.objects.new(name, cu))
    o.data.materials.append(m)
    return pts


# ---------------- cảnh ----------------
def build(night):
    reset()
    sc = bpy.context.scene
    W = mat("wall", (0.88, 0.85, 0.79), 0.8)
    CLAD = mat_noise("clad", (0.07, 0.075, 0.085), (0.11, 0.115, 0.125), 30, 0.55)
    W2 = mat("wall2", (0.1, 0.105, 0.115), 0.6)
    PLINTH = mat("plinth", (0.16, 0.17, 0.19), 0.7)
    ROOF = mat("roof", (0.045, 0.05, 0.06), 0.45)
    FASCIA = mat("fascia", (0.05, 0.05, 0.06), 0.5)
    FRAME = mat("frame", (0.06, 0.065, 0.075), 0.35, 0.4)
    GLASS = mat("glass", (0.05, 0.08, 0.11), 0.04, 0.0, 1.0) if not night else mat("glassN", (0.9, 0.55, 0.22), 0.2, emit=(1.0, 0.5, 0.16), estr=1.8)
    GLASS_DIM = mat("glassd", (0.05, 0.08, 0.11), 0.04, 0.0, 1.0) if not night else mat("glassdN", (0.3, 0.22, 0.15), 0.2, emit=(1.0, 0.62, 0.3), estr=0.7)
    WOOD = mat_wood()
    DOOR = mat("door", (0.12, 0.08, 0.05), 0.5)
    GDOOR = mat("gdoor", (0.55, 0.56, 0.58), 0.45, 0.3)
    GROOVE = mat("groove", (0.25, 0.26, 0.28), 0.5)
    PV = mat_panel()
    ALU = mat("alu", (0.75, 0.77, 0.8), 0.3, 1.0)
    LAWN = mat_noise("lawn", (0.08, 0.24, 0.04), (0.16, 0.37, 0.07), 3.0, 0.9)
    HILL = mat_noise("hill", (0.08, 0.2, 0.1), (0.13, 0.3, 0.15), 0.4, 0.95)
    CONC = mat_noise("conc", (0.62, 0.61, 0.58), (0.75, 0.74, 0.71), 8, 0.85)
    ASPH = mat_noise("asph", (0.08, 0.085, 0.09), (0.15, 0.155, 0.16), 14, 0.9)
    PAINT = mat("paint", (0.92, 0.92, 0.9), 0.6)
    TRUNK = mat("trunk", (0.22, 0.14, 0.08), 0.8)
    LEAF = mat_noise("leaf", (0.03, 0.16, 0.03), (0.1, 0.32, 0.06), 5, 0.7)
    LEAF2 = mat_noise("leaf2", (0.1, 0.3, 0.03), (0.26, 0.5, 0.07), 5, 0.7)
    LEAF3 = mat_noise("leaf3", (0.25, 0.22, 0.04), (0.5, 0.36, 0.06), 5, 0.7)
    HEDGE = mat_noise("hedge", (0.02, 0.13, 0.03), (0.07, 0.26, 0.05), 7, 0.75)
    POLE = mat("pole", (0.42, 0.42, 0.4), 0.7)
    CABLE = mat("cable", (0.03, 0.03, 0.03), 0.4)
    CAR = mat("car", (0.015, 0.07, 0.24), 0.22, 0.65, 1.0)
    CARGL = mat("cargl", (0.02, 0.025, 0.03), 0.05, 0.0, 1.0)
    TIRE = mat("tire", (0.02, 0.02, 0.02), 0.85)
    RIM = mat("rim", (0.6, 0.62, 0.65), 0.25, 1.0)
    WHITE = mat("white", (0.93, 0.93, 0.92), 0.3, 0.0, 0.5)
    SCREEN = mat("screen", (0.01, 0.02, 0.04), 0.2, emit=(0.2, 0.7, 1.0), estr=1.5 if night else 0.4)
    LAMP = mat("lamp", (1, 0.9, 0.7), 0.3, emit=(1.0, 0.82, 0.55), estr=25 if night else 0)
    ESSF = mat_image("essfront", ESS_TEX)

    # nền
    box("lawn", (-150, -40, -0.1), (150, 160, 0), LAWN)
    for x, y, sx, sz in ((-90, 170, 90, 16), (20, 200, 120, 22), (130, 180, 100, 18), (220, 150, 80, 14), (-200, 140, 80, 12)):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, location=(x, y, 0))
        h = bpy.context.active_object
        h.scale = (sx, sx * 0.45, sz)
        h.data.materials.append(HILL)
        bpy.ops.object.shade_smooth()
    for i in range(46):
        x = -70 + i * 3.4 + (i * 7 % 5)
        y = 62 + (i * 13 % 11)
        s = 1.2 + (i * 5 % 7) / 6
        blob("bgtree", (x, y, 2.4 * s), (1.5 * s, 1.5 * s, 2.2 * s), LEAF if i % 2 else LEAF2)
    box("walk", (-150, -12.2, 0), (150, -10.2, 0.06), CONC)
    box("curb", (-150, -12.4, 0), (150, -12.2, 0.14), CONC)
    box("road", (-150, -22, 0), (150, -12.4, 0.02), ASPH)
    for x in range(-60, 60, 7):
        box("dash", (x, -17.3, 0.02), (x + 3.2, -17.1, 0.025), PAINT)
    box("drive", (9.6, -10.2, 0), (13.6, 0.4, 0.04), CONC)
    box("path", (0.9, -10.2, 0), (2.3, 0, 0.04), CONC)

    # nhà chính 9 x 7, cao 6 (2 tầng), mặt tiền hướng -Y
    box("house", (0, 0, 0), (9, 7, 6), W)
    box("plinth", (-0.02, -0.02, 0), (9.02, 7.02, 0.35), PLINTH)
    box("band", (-0.04, -0.04, 2.95), (9.04, 7.04, 3.1), W2)
    # mái dốc 2 mái, nóc dọc trục X
    ey, ez, ry, rz = -0.55, 5.72, 3.5, 8.55
    quad_slab("roofF", [(-0.5, ey, ez), (9.5, ey, ez), (9.5, ry, rz), (-0.5, ry, rz)], 0.24, ROOF)
    quad_slab("roofB", [(-0.5, ry, rz), (9.5, ry, rz), (9.5, 7.55, ez), (-0.5, 7.55, ez)], 0.24, ROOF)
    for x in (0.0, 9.0):
        quad_slab("gable", [(x, 0, 6), (x, 7, 6), (x, 3.5, 8.5)], 0.02 if x else -0.02, W)
    box("fascia", (-0.5, ey - 0.06, ez - 0.22), (9.5, ey + 0.06, ez + 0.02), FASCIA)
    # tấm pin trên mái trước: 7 cột x 2 hàng
    slope = math.atan2(rz - ez, ry - ey)
    L = math.hypot(ry - ey, rz - ez)
    nrm = Vector((0, -math.sin(slope), math.cos(slope)))
    pv_pts = []
    for row in range(2):
        for col in range(7):
            t = 0.1 + row * 0.42 + 0.19
            c = Vector((0.75 + col * 1.08 + 0.52, ey + (ry - ey) * t, ez + (rz - ez) * t)) + nrm * 0.33
            bpy.ops.mesh.primitive_cube_add(size=1, location=c, rotation=(slope, 0, 0))
            p = bpy.context.active_object
            p.scale = (1.02, L * 0.38, 0.05)
            p.data.materials.append(PV)
            bv = p.modifiers.new("b", "BEVEL")
            bv.width = 0.02
            bpy.ops.mesh.primitive_cube_add(size=1, location=c - nrm * 0.03, rotation=(slope, 0, 0))
            f = bpy.context.active_object
            f.scale = (1.06, L * 0.39, 0.05)
            f.data.materials.append(ALU)
            pv_pts.append(c)
    # ốp gỗ quanh cửa chính + mái che
    box("woodclad", (0, -0.06, 0.35), (3.0, 0.0, 2.95), WOOD)
    box("door", (1.0, -0.1, 0.35), (2.2, -0.05, 2.55), DOOR)
    box("handle", (1.95, -0.14, 1.3), (2.0, -0.1, 1.7), ALU)
    box("canopy", (0.6, -1.3, 2.75), (2.6, 0.0, 2.88), FASCIA)
    box("lamp1", (2.42, -0.12, 2.05), (2.58, -0.06, 2.3), LAMP)

    def window(x0, x1, z0, z1, y=0.0, face="F", gm=GLASS, mull=True):
        if face == "F":
            box("wf", (x0, y - 0.1, z0), (x1, y + 0.02, z1), FRAME)
            box("wg", (x0 + 0.07, y - 0.13, z0 + 0.07), (x1 - 0.07, y - 0.1, z1 - 0.07), gm)
            if mull:
                xm = (x0 + x1) / 2
                box("mu", (xm - 0.03, y - 0.15, z0), (xm + 0.03, y - 0.12, z1), FRAME)
        else:  # mặt +X
            box("wf", (y - 0.02, x0, z0), (y + 0.1, x1, z1), FRAME)
            box("wg", (y + 0.1, x0 + 0.07, z0 + 0.07), (y + 0.13, x1 - 0.07, z1 - 0.07), gm)

    window(3.3, 8.4, 0.75, 2.75)
    window(0.8, 3.6, 3.45, 5.4)
    window(4.6, 8.4, 3.45, 5.4)
    window(1.4, 3.6, 3.8, 5.3, y=9.0, face="R", gm=GLASS_DIM)
    window(4.6, 6.2, 3.8, 5.3, y=9.0, face="R", gm=GLASS_DIM)

    # gara mái bằng, lùi 0.4 m
    box("garage", (9, 0.4, 0), (15, 7, 3.3), CLAD)
    box("gplinth", (8.98, 0.38, 0), (15.02, 7.02, 0.35), PLINTH)
    box("gcap", (8.95, 0.3, 3.3), (15.05, 7.05, 3.5), W2)
    box("gdoor", (9.7, 0.3, 0.04), (13.3, 0.42, 2.6), GDOOR)
    for z in (0.65, 1.3, 1.95):
        box("gr", (9.7, 0.27, z - 0.02), (13.3, 0.3, z + 0.02), GROOVE)
    box("glamp", (11.4, 0.22, 2.75), (11.6, 0.3, 2.9), LAMP)
    # bộ pin lưu trữ (mặt trước dùng ảnh thiết kế) + biến tần
    ew, eh, ed = 0.72, 0.72 * 789 / 467, 0.24
    ex0, ey0 = 13.75, 0.4 - ed
    box("essbody", (ex0, ey0 + 0.01, 0.05), (ex0 + ew, 0.39, 0.05 + eh), WHITE, bevel=0.025)
    me = bpy.data.meshes.new("essface")
    me.from_pydata([(ex0, ey0, 0.05), (ex0 + ew, ey0, 0.05), (ex0 + ew, ey0, 0.05 + eh), (ex0, ey0, 0.05 + eh)], [], [(0, 1, 2, 3)])
    me.update()
    uv = me.uv_layers.new()
    for i, c in enumerate([(0, 0), (1, 0), (1, 1), (0, 1)]):
        uv.data[i].uv = c
    ef = link(bpy.data.objects.new("essface", me))
    ef.data.materials.append(ESSF)
    box("inv", (14.55, 0.22, 1.25), (14.95, 0.4, 1.95), WHITE, bevel=0.02)
    box("invscr", (14.62, 0.2, 1.68), (14.88, 0.22, 1.82), SCREEN)
    box("conduit", (14.73, 0.32, 1.95), (14.77, 0.36, 3.3), FRAME)

    # hàng rào cây bụi, cây
    for x0, x1 in ((-0.2, 0.8), (3.2, 8.6)):
        box("hedge", (x0, -1.0, 0), (x1, -0.45, 0.75), HEDGE, bevel=0.2, seg=3)
    for x, y, s in ((-4.5, 3, 1.25), (-3.2, 11, 1.5), (5, 13, 1.7), (13, 12, 1.45), (19, 6, 1.35), (-8.5, 1, 1.05), (24, 16, 1.6), (-14, 14, 1.6)):
        tree(x, y, s, TRUNK, LEAF3 if (x, y) in ((19, 6), (-14, 14)) else LEAF, LEAF2)

    # ô tô điện SUV dáng coupe (thiết kế riêng), đỗ trên lối vào, đầu hướng vào gara
    cx, cy, CL = 11.6, -4.2, 4.55
    cy0 = cy - CL / 2

    def loft(name, stations, m):
        verts, faces, n = [], [], 8
        for t, wb, z0, wt, z1 in stations:
            y = cy0 + t * CL
            ring = [(-wb, z0 + 0.12), (-wb * 0.9, z0), (wb * 0.9, z0), (wb, z0 + 0.12), (wt, z1 - 0.06), (wt * 0.85, z1), (-wt * 0.85, z1), (-wt, z1 - 0.06)]
            verts += [(cx + x, y, z) for x, z in ring]
        for i in range(len(stations) - 1):
            for k in range(n):
                a0, b0 = i * n + k, i * n + (k + 1) % n
                faces.append((a0, b0, b0 + n, a0 + n))
        faces.append(tuple(range(n)))
        faces.append(tuple(range((len(stations) - 1) * n, len(stations) * n)))
        me = bpy.data.meshes.new(name)
        me.from_pydata(verts, [], faces)
        bm = bmesh.new()
        bm.from_mesh(me)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(me)
        bm.free()
        o = link(bpy.data.objects.new(name, me))
        o.data.materials.append(m)
        sd = o.modifiers.new("sd", "SUBSURF")
        sd.levels = sd.render_levels = 2
        for pgn in o.data.polygons:
            pgn.use_smooth = True
        return o

    loft("carbody", [(0.0, 0.84, 0.42, 0.78, 0.98), (0.05, 0.92, 0.36, 0.86, 1.07), (0.2, 0.94, 0.33, 0.88, 1.1), (0.5, 0.94, 0.33, 0.88, 1.1),
                     (0.72, 0.94, 0.33, 0.88, 1.06), (0.88, 0.92, 0.36, 0.86, 0.98), (0.97, 0.88, 0.4, 0.8, 0.86), (1.0, 0.78, 0.46, 0.68, 0.78)], CAR)
    loft("greenhouse", [(0.09, 0.8, 1.0, 0.72, 1.1), (0.18, 0.84, 1.0, 0.66, 1.42), (0.32, 0.85, 1.0, 0.63, 1.6), (0.52, 0.85, 1.0, 0.63, 1.62),
                        (0.63, 0.85, 1.0, 0.66, 1.5), (0.75, 0.83, 1.0, 0.74, 1.08)], CARGL)
    TL = mat("tl", (0.5, 0.02, 0.02), 0.3, emit=(1, 0.06, 0.03), estr=8 if night else 0.8)
    box("taillight", (cx - 0.78, cy0 - 0.03, 0.9), (cx + 0.78, cy0 + 0.02, 0.95), TL, bevel=0.01)
    box("frontbar", (cx - 0.7, cy0 + CL - 0.04, 0.8), (cx + 0.7, cy0 + CL + 0.01, 0.83), mat("drl", (0.9, 0.95, 1), 0.2, emit=(0.85, 0.92, 1), estr=10 if night else 1.0))
    RIMD = mat("rimd", (0.08, 0.085, 0.095), 0.3, 1.0)
    for wx in (cx - 0.86, cx + 0.86):
        for t in (0.17, 0.8):
            wy = cy0 + t * CL
            cyl("tire", 0.39, 0.28, (wx, wy, 0.39), TIRE, rot=(0, math.pi / 2, 0), verts=32)
            cyl("rim", 0.25, 0.3, (wx, wy, 0.39), RIMD, rot=(0, math.pi / 2, 0), verts=32)
            cyl("hub", 0.11, 0.31, (wx, wy, 0.39), RIM, rot=(0, math.pi / 2, 0), verts=20)

    # cột điện bê tông côn, xà thép có thanh giằng, sứ cách điện, máy biến áp treo, đèn đường
    px, py = 18.6, -10.7
    CONC2 = mat_noise("pconc", (0.5, 0.49, 0.46), (0.62, 0.6, 0.56), 18, 0.85)
    STEEL = mat("steel", (0.32, 0.33, 0.35), 0.4, 0.8)
    PORC = mat("porc", (0.85, 0.85, 0.82), 0.15, 0.0, 0.8)
    bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.21, radius2=0.11, depth=10.0, location=(px, py, 5.0))
    pl = bpy.context.active_object
    pl.data.materials.append(CONC2)
    bpy.ops.object.shade_smooth()
    box("arm", (px - 1.1, py - 0.06, 9.05), (px + 1.1, py + 0.06, 9.17), STEEL)
    for sx in (-1, 1):
        bpy.ops.mesh.primitive_cylinder_add(radius=0.025, depth=1.15, location=(px + sx * 0.42, py, 8.82), rotation=(0, sx * math.radians(52), 0))
        bpy.context.active_object.data.materials.append(STEEL)
    for dx in (-0.95, 0.0, 0.95):
        for k in range(3):
            cyl("disc", 0.075 - k * 0.006, 0.045, (px + dx, py, 9.24 + k * 0.07), PORC, verts=16)
    # máy biến áp
    cyl("xfmr", 0.38, 1.0, (px - 0.52, py, 7.3), mat("xf", (0.45, 0.47, 0.48), 0.45, 0.5), verts=28)
    box("xbr", (px - 0.2, py - 0.05, 7.0), (px, py + 0.05, 7.6), STEEL)
    for dx in (-0.66, -0.38):
        cyl("bush", 0.04, 0.2, (px + dx, py, 7.9), PORC, verts=10)
    # dây trung thế dọc đường + dây hạ thế vào nhà
    for dx in (-0.95, 0.0, 0.95):
        wire("hv", (px + dx, py, 9.32), (px + dx + 45, py - 1.5, 9.32), 2.4, CABLE, 0.016)
    wire_pts = wire("w1", (px - 0.52, py, 7.82), (15.0, 0.32, 3.35), 0.9, CABLE, 0.02)
    box("meter", (14.98, 0.18, 2.75), (15.06, 0.42, 3.15), WHITE)

    # ánh sáng
    world = bpy.data.worlds.new("world")
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    if night:
        bg.inputs["Color"].default_value = (0.03, 0.05, 0.11, 1)
        bg.inputs["Strength"].default_value = 0.6
    else:
        sky = world.node_tree.nodes.new("ShaderNodeTexSky")
        sky.sky_type = "PREETHAM"
        sky.sun_direction = Vector((-0.45, -0.6, 0.65)).normalized()
        sky.turbidity = 2.4
        world.node_tree.links.new(sky.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 0.22
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 0.35 if night else 3.0
    sun.color = (0.6, 0.7, 1.0) if night else (1.0, 0.96, 0.9)
    sun.angle = math.radians(3 if night else 1.5)
    so = link(bpy.data.objects.new("sun", sun))
    so.rotation_euler = Euler((math.radians(52), 0, math.radians(-42 if not night else 30)))
    if night:
        for loc, e, c in (((2.5, -0.8, 2.2), 60, (1, 0.8, 0.55)), ((11.5, -0.4, 2.7), 90, (1, 0.85, 0.6)), ((5.8, -1.6, 1.6), 25, (1, 0.65, 0.35)), ((5.8, -1.4, 4.4), 18, (1, 0.65, 0.35))):
            l = bpy.data.lights.new("pt", "POINT")
            l.energy = e
            l.color = c
            l.shadow_soft_size = 0.4
            link(bpy.data.objects.new("pt", l)).location = loc

    # máy ảnh góc 3/4
    cam = bpy.data.cameras.new("cam")
    cam.lens = float(os.environ.get("LENS", "40"))
    co = link(bpy.data.objects.new("cam", cam))
    co.location = Vector(tuple(float(v) for v in os.environ.get("CAM", "22,-27.5,11.5").split(",")))
    tgt = Vector(tuple(float(v) for v in os.environ.get("TGT", "7.4,2.0,3.4").split(",")))
    co.rotation_euler = (tgt - co.location).to_track_quat("-Z", "Y").to_euler()
    sc.camera = co

    r = sc.render
    r.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.use_denoising = True
    try:
        sc.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    sc.cycles.max_bounces = 6
    r.film_transparent = True
    r.resolution_x, r.resolution_y = RES
    r.resolution_percentage = 100
    r.image_settings.file_format = "PNG"
    r.image_settings.color_mode = "RGBA"
    for vt in ("Khronos PBR Neutral", "Standard"):
        try:
            sc.view_settings.view_transform = vt
            break
        except Exception:
            continue
    sc.view_settings.exposure = -0.1 if not night else 0.1

    bpy.context.view_layer.update()
    # điểm neo 2D cho lớp phủ (tỉ lệ 0..1, gốc trên-trái)
    def proj(p):
        v = world_to_camera_view(sc, co, Vector(p))
        return [round(v.x, 4), round(1 - v.y, 4)]

    pv_mid = sum(pv_pts[7:], Vector()) / 7
    anchors = {
        "res": list(RES),
        "pv": proj(pv_mid + nrm * 0.6),
        "pv_flow": [proj((9.4, -0.62, 5.6)), proj((9.4, 0.25, 3.5)), proj((14.75, 0.25, 3.45)), proj((14.75, 0.2, 1.98))],
        "inv": proj((14.75, 0.2, 1.6)),
        "load_flow": [proj((14.55, 0.18, 1.6)), proj((13.4, 0.2, 2.85)), proj((8.6, 0.25, 2.85)), proj((8.4, -0.15, 1.8))],
        "house": proj((5.8, -0.2, 1.8)),
        "bat_flow": [proj((14.75, 0.18, 1.25)), proj((14.75, 0.15, 1.05)), proj((ex0 + ew - 0.05, ey0 - 0.01, 1.0))],
        "ess": proj((ex0 + ew / 2, ey0, 0.05 + eh * 0.55)),
        "ess_disp": [proj((ex0 + ew * 0.499, ey0 - 0.005, 0.05 + eh * (1 - 0.148))), proj((ex0 + ew * 0.499 + ew * 0.075, ey0 - 0.005, 0.05 + eh * (1 - 0.148))), proj((ex0 + ew * 0.499, ey0 - 0.005, 0.05 + eh * (1 - 0.148) + ew * 0.075))],
        "grid_flow": [proj(p) for p in wire_pts],
        "pole_top": proj((px, py, 9.6)),
    }
    return anchors


# MỚI (31/10/2026): vị trí mặt trời theo giờ (vĩ độ Thanh Hoá ~19.8°B, xích vĩ trung bình).
# Máy ảnh nhìn về hướng Bắc (+Y), Đông = +X (bên phải ảnh) → sáng nắng từ phải, chiều nắng từ trái.
LAT, DECL = math.radians(19.8), math.radians(-8)


def sun_at(hour):
    H = math.radians(15 * (hour - 12))
    se = math.sin(LAT) * math.sin(DECL) + math.cos(LAT) * math.cos(DECL) * math.cos(H)
    el = math.asin(se)
    az = math.atan2(-math.sin(H) * math.cos(DECL), math.cos(LAT) * math.sin(DECL) - math.sin(LAT) * math.cos(DECL) * math.cos(H))
    return az, el  # az: từ Bắc theo chiều kim đồng hồ


def set_sun(hour):
    az, el = sun_at(hour)
    el_l = max(el, math.radians(4))
    s = Vector((math.sin(az) * math.cos(el_l), math.cos(az) * math.cos(el_l), math.sin(el_l)))
    so = bpy.data.objects["sun"]
    so.rotation_euler = (-s).to_track_quat("-Z", "Y").to_euler()
    k = max(0.0, min(1.0, math.sin(el_l) / 0.6))  # 0 khi sát chân trời, 1 khi cao
    so.data.energy = 0.9 + 2.3 * k
    warm = 1 - k
    so.data.color = (1.0, 0.96 - 0.3 * warm, 0.9 - 0.5 * warm)
    sky = [n for n in bpy.context.scene.world.node_tree.nodes if n.type == "TEX_SKY"][0]
    sky.sun_direction = s
    bpy.context.scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12 + 0.12 * k
    return az, el


if WHICH == "hours":
    anchors = build(False)
    hours = [float(h) for h in os.environ.get("HOURS", "6,7,8,9,10,11,12,13,14,15,16,17,18").split(",")]
    for h in hours:
        az, el = set_sun(h)
        bpy.context.scene.render.filepath = os.path.join(OUT, "house_%02d.png" % int(h))
        bpy.ops.render.render(write_still=True)
        print("rendered hour", h, "az", round(math.degrees(az)), "el", round(math.degrees(el)), flush=True)
    with open(os.path.join(OUT, "anchors.json"), "w") as f:
        json.dump(anchors, f)
    sys.exit(0)

targets = {"day": [False], "night": [True], "both": [False, True]}[WHICH]
anchors = None
for night in targets:
    anchors = build(night)
    bpy.context.scene.render.filepath = os.path.join(OUT, "house_night.png" if night else "house_day.png")
    bpy.ops.render.render(write_still=True)
    print("rendered", "night" if night else "day", flush=True)
with open(os.path.join(OUT, "anchors.json"), "w") as f:
    json.dump(anchors, f)
print(json.dumps(anchors)[:400])
