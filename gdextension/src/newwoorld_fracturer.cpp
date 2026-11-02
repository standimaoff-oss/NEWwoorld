#include "newwoorld_fracturer.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/math.hpp>
#include <godot_cpp/variant/basis.hpp>
#include <godot_cpp/variant/color.hpp>

#include <algorithm>
#include <cmath>

using namespace godot;

namespace newwoorld {

namespace {

/// Детерминированный псевдослучайный спин по координатам воксела.
///
/// Намеренно НЕ используем Math::randd(): с ним нарезка недетерминирована,
/// и тест «взрыв дал 34 осколка с такими-то импульсами» превращается в
/// лотерею. Детерминированность стоит нуля усилий, а визуальная разница
/// между хешем и randd() на глаз неотличима.
inline double _spin_hash(int64_t p_seed_value, int p_component) {
    uint64_t x = static_cast<uint64_t>(p_seed_value) * 0x9E3779B97F4A7C15ULL;
    x ^= static_cast<uint64_t>(p_component) * 0xC2B2AE3D27D4EB4FULL;
    x ^= x >> 29;
    x *= 0xBF58476D1CE4E5B9ULL;
    x ^= x >> 32;
    // Приводим к диапазону -1..1
    return (static_cast<double>(x & 0xFFFFFFFFULL) / 2147483647.5) - 1.0;
}

/// Потолок числа осколков на одну нарезку, независимо от энергии и бюджета.
/// Защита от ситуации «художник задал cell_size = 0.001» — без неё один
/// ящик породил бы миллион тел и положил игру намертво.
constexpr int kHardChunkCap = 512;

/// Минимальный размер воксела в метрах. Меньше физически бессмысленно:
/// осколок размером с миллиметр невидим, но физику считает.
constexpr double kMinCellSize = 0.05;

} // namespace

void NewwoorldFracturer::_bind_methods() {
    ClassDB::bind_method(
            D_METHOD("fracture", "mesh", "transform", "impact_point", "impact_normal",
                    "energy", "cell_size", "chunk_budget"),
            &NewwoorldFracturer::fracture);

    ClassDB::bind_method(D_METHOD("estimate_chunk_count", "mesh", "energy", "cell_size"),
            &NewwoorldFracturer::estimate_chunk_count);

    ClassDB::bind_method(
            D_METHOD("compute_impulse", "local_centroid", "local_impact", "impact_normal",
                    "energy"),
            &NewwoorldFracturer::compute_impulse);

    ClassDB::bind_method(D_METHOD("last_statistics"), &NewwoorldFracturer::last_statistics);
    ClassDB::bind_method(D_METHOD("last_chunk_count"), &NewwoorldFracturer::last_chunk_count);
}

int64_t NewwoorldFracturer::_voxel_key(const Vector3i &p_voxel) {
    // Смещаем в положительную половину и упаковываем три координаты в int64.
    // 21 бит на ось = диапазон ±1 млн вокселов, чего хватает с огромным запасом.
    const int64_t x = static_cast<int64_t>(p_voxel.x) + 1048576;
    const int64_t y = static_cast<int64_t>(p_voxel.y) + 1048576;
    const int64_t z = static_cast<int64_t>(p_voxel.z) + 1048576;
    return (x << 42) | (y << 21) | z;
}

void NewwoorldFracturer::_compute_bounds(const PackedVector3Array &p_vertices,
        Vector3 &r_min, Vector3 &r_max) {
    if (p_vertices.size() == 0) {
        r_min = Vector3();
        r_max = Vector3();
        return;
    }
    r_min = p_vertices[0];
    r_max = p_vertices[0];
    for (int i = 1; i < p_vertices.size(); i++) {
        const Vector3 &v = p_vertices[i];
        r_min.x = MIN(r_min.x, v.x);
        r_min.y = MIN(r_min.y, v.y);
        r_min.z = MIN(r_min.z, v.z);
        r_max.x = MAX(r_max.x, v.x);
        r_max.y = MAX(r_max.y, v.y);
        r_max.z = MAX(r_max.z, v.z);
    }
}

void NewwoorldFracturer::_build_chunks(const PackedVector3Array &p_vertices,
        const PackedInt32Array &p_indices, const Vector3 &p_local_impact,
        double p_cell_size, int p_chunk_budget) {
    _chunks.clear();
    _voxel_index.clear();

    const double cell = MAX(kMinCellSize, p_cell_size);
    const bool indexed = p_indices.size() >= 3;
    const int face_count = indexed ? (p_indices.size() / 3) : (p_vertices.size() / 3);

    Vector3 bounds_min;
    Vector3 bounds_max;
    _compute_bounds(p_vertices, bounds_min, bounds_max);

    for (int face = 0; face < face_count; face++) {
        const int i0 = indexed ? p_indices[face * 3 + 0] : face * 3 + 0;
        const int i1 = indexed ? p_indices[face * 3 + 1] : face * 3 + 1;
        const int i2 = indexed ? p_indices[face * 3 + 2] : face * 3 + 2;
        if (i0 < 0 || i1 < 0 || i2 < 0) {
            continue;
        }
        if (i0 >= p_vertices.size() || i1 >= p_vertices.size()
                || i2 >= p_vertices.size()) {
            // Битый индексный буфер. Пропускаем треугольник, а не падаем:
            // лучше кусок стены без одной грани, чем краш при взрыве.
            continue;
        }
        const Vector3 &v0 = p_vertices[i0];
        const Vector3 &v1 = p_vertices[i1];
        const Vector3 &v2 = p_vertices[i2];
        const Vector3 centroid = (v0 + v1 + v2) * (1.0 / 3.0);

        const Vector3i voxel(
                static_cast<int>(Math::floor((centroid.x - bounds_min.x) / cell)),
                static_cast<int>(Math::floor((centroid.y - bounds_min.y) / cell)),
                static_cast<int>(Math::floor((centroid.z - bounds_min.z) / cell)));

        const int64_t key = _voxel_key(voxel);
        auto it = _voxel_index.find(key);
        int chunk_id;
        if (it == _voxel_index.end()) {
            chunk_id = static_cast<int>(_chunks.size());
            _voxel_index.emplace(key, chunk_id);
            ChunkData chunk;
            chunk.voxel = voxel;
            chunk.centroid = centroid;
            chunk.bounds_min = centroid;
            chunk.bounds_max = centroid;
            chunk.vertex_count = 0;
            chunk.impact_distance = centroid.distance_to(p_local_impact);
            _chunks.push_back(chunk);
        } else {
            chunk_id = it->second;
            ChunkData &chunk = _chunks[chunk_id];
            // Центроид — среднее центроидов треугольников. Точнее было бы
            // считать по площадям, но для импульса разница незаметна, а
            // площадь требует двух векторных произведений на треугольник.
            chunk.centroid = (chunk.centroid * static_cast<double>(chunk.faces.size())
                                     + centroid)
                    / static_cast<double>(chunk.faces.size() + 1);
            chunk.bounds_min.x = MIN(chunk.bounds_min.x, MIN(MIN(v0.x, v1.x), v2.x));
            chunk.bounds_min.y = MIN(chunk.bounds_min.y, MIN(MIN(v0.y, v1.y), v2.y));
            chunk.bounds_min.z = MIN(chunk.bounds_min.z, MIN(MIN(v0.z, v1.z), v2.z));
            chunk.bounds_max.x = MAX(chunk.bounds_max.x, MAX(MAX(v0.x, v1.x), v2.x));
            chunk.bounds_max.y = MAX(chunk.bounds_max.y, MAX(MAX(v0.y, v1.y), v2.y));
            chunk.bounds_max.z = MAX(chunk.bounds_max.z, MAX(MAX(v0.z, v1.z), v2.z));
        }
        ChunkData &chunk = _chunks[chunk_id];
        chunk.faces.push_back(face);
        chunk.vertex_count += 3;
    }

    // Ближайшие к удару куски важнее: при нехватке бюджета режем дальние.
    std::sort(_chunks.begin(), _chunks.end(),
            [](const ChunkData &a, const ChunkData &b) {
                return a.impact_distance < b.impact_distance;
            });

    const int cap = MIN(MIN(p_chunk_budget, kHardChunkCap),
            static_cast<int>(_chunks.size()));
    if (cap > 0 && cap < static_cast<int>(_chunks.size())) {
        _chunks.resize(static_cast<size_t>(cap));
    }
}

Vector3 NewwoorldFracturer::compute_impulse(const Vector3 &p_local_centroid,
        const Vector3 &p_local_impact, const Vector3 &p_impact_normal,
        double p_energy) const {
    Vector3 away = p_local_centroid - p_local_impact;
    if (away.length_squared() < 0.000001) {
        // Точка удара совпала с центроидом: толкаем по нормали, иначе
        // осколок не сдвинется вообще и повиснет в воздухе.
        away = p_impact_normal.length_squared() > 0.000001 ? p_impact_normal : Vector3(0, 1, 0);
    }
    // Импульс растёт с энергией, но корень из энергии не даёт «пушке,
    // которая выбрасывает обломки за горизонт» на больших значениях.
    const double magnitude = 1.0 + Math::sqrt(MAX(0.0, p_energy)) * 0.06;
    return away.normalized() * magnitude;
}

Ref<ArrayMesh> NewwoorldFracturer::_build_chunk_mesh(
        const PackedVector3Array &p_vertices, const PackedInt32Array &p_indices,
        const PackedVector3Array &p_normals, const ChunkData &p_chunk) const {
    const bool indexed = p_indices.size() >= 3;
    const bool has_normals = p_normals.size() == p_vertices.size();

    // Локальная карта вершин: чанк почти всегда использует лишь малую долю
    // вершин исходного меша. Копировать весь массив вершин в каждый осколок
    // — это O(N*M) памяти, где M число осколков. На 20k-вершинном меше и
    // 64 осколках разница — 1.3 млн вершин вместо 20 тысяч.
    std::unordered_map<int, int> remap;
    remap.reserve(static_cast<size_t>(p_chunk.vertex_count) + 8);

    PackedVector3Array out_vertices;
    PackedVector3Array out_normals;
    PackedInt32Array out_indices;
    out_vertices.resize(p_chunk.vertex_count);
    if (has_normals) {
        out_normals.resize(p_chunk.vertex_count);
    }
    out_indices.resize(static_cast<int>(p_chunk.faces.size()) * 3);

    int write_index = 0;
    int index_write = 0;
    for (size_t f = 0; f < p_chunk.faces.size(); f++) {
        const int face = p_chunk.faces[f];
        for (int corner = 0; corner < 3; corner++) {
            const int src = indexed ? p_indices[face * 3 + corner] : face * 3 + corner;
            auto found = remap.find(src);
            int local;
            if (found == remap.end()) {
                local = write_index++;
                remap.emplace(src, local);
                out_vertices[local] = p_vertices[src];
                if (has_normals) {
                    out_normals[local] = p_normals[src];
                }
            } else {
                local = found->second;
            }
            out_indices[index_write++] = local;
        }
    }

    // Вершины могли остаться незаполненными, если индексный буфер битый.
    if (write_index < p_chunk.vertex_count) {
        out_vertices.resize(write_index);
        out_indices.resize(index_write);
        if (has_normals) {
            out_normals.resize(write_index);
        }
    }
    if (out_vertices.size() < 3) {
        return Ref<ArrayMesh>();
    }

    TypedArray<Array> arrays;
    arrays.resize(Mesh::ARRAY_MAX);
    arrays[Mesh::ARRAY_VERTEX] = out_vertices;
    arrays[Mesh::ARRAY_INDEX] = out_indices;
    if (has_normals && out_normals.size() == out_vertices.size()) {
        arrays[Mesh::ARRAY_NORMAL] = out_normals;
    }

    Ref<ArrayMesh> mesh;
    mesh.instantiate();
    mesh->add_surface_from_arrays(Mesh::PRIMITIVE_TRIANGLES, arrays);
    return mesh;
}

Array NewwoorldFracturer::fracture(const Ref<Mesh> &p_mesh, const Transform3D &p_transform,
        const Vector3 &p_impact_point, const Vector3 &p_impact_normal, double p_energy,
        double p_cell_size, int p_chunk_budget) {
    Array result;
    _stats = Dictionary();

    if (p_mesh.is_null()) {
        _stats["error"] = "mesh is null";
        return result;
    }
    if (p_mesh->get_surface_count() == 0) {
        _stats["error"] = "mesh has no surfaces";
        return result;
    }

    Array surface_arrays = p_mesh->surface_get_arrays(0);
    if (surface_arrays.size() <= Mesh::ARRAY_INDEX) {
        _stats["error"] = "surface arrays malformed";
        return result;
    }

    PackedVector3Array vertices = surface_arrays[Mesh::ARRAY_VERTEX];
    PackedInt32Array indices = surface_arrays[Mesh::ARRAY_INDEX];
    PackedVector3Array normals = surface_arrays[Mesh::ARRAY_NORMAL];

    if (vertices.size() < 3) {
        _stats["error"] = "mesh has fewer than 3 vertices";
        return result;
    }

    // Точка удара переводится в ЛОКАЛЬНЫЕ координаты объекта: нарезка идёт
    // по локальной геометрии, иначе повёрнутый объект развалился бы
    // асимметрично относительно удара.
    //
    // xform_inv на базисе корректен для ортонормированных базисов (поворот +
    // равномерный масштаб). На неравномерном масштабе направление исказится,
    // но разрушаемые объекты не масштабируют неоднородно — это ломает и
    // физику, и нормали, поэтому отдельный inverse-transpose здесь избыточен.
    const Vector3 local_impact = p_transform.xform_inv(p_impact_point);
    const Vector3 local_normal = p_transform.basis.xform_inv(p_impact_normal).normalized();

    _build_chunks(vertices, indices, local_impact, p_cell_size, p_chunk_budget);

    const int total_chunks = static_cast<int>(_chunks.size());
    result.resize(total_chunks);

    for (int c = 0; c < total_chunks; c++) {
        const ChunkData &chunk = _chunks[c];
        Ref<ArrayMesh> piece_mesh = _build_chunk_mesh(vertices, indices, normals, chunk);
        if (piece_mesh.is_null()) {
            continue;
        }
        Dictionary entry;
        entry["mesh"] = piece_mesh;
        entry["offset"] = chunk.centroid;
        entry["impulse"] = compute_impulse(chunk.centroid, local_impact, local_normal, p_energy);
        // Детерминированный спин: воспроизводимые тесты, одинаковый вид
        // при повторном проигрывании одного и того же взрыва.
        const int64_t seed_value = _voxel_key(chunk.voxel);
        entry["spin"] = Vector3(
                _spin_hash(seed_value, 0) * 6.0,
                _spin_hash(seed_value, 1) * 6.0,
                _spin_hash(seed_value, 2) * 6.0);
        entry["piece_index"] = c;
        entry["voxel"] = chunk.voxel;
        result[c] = entry;
    }

    _stats["chunks"] = total_chunks;
    _stats["source_vertices"] = vertices.size();
    _stats["source_faces"] = indices.size() >= 3 ? indices.size() / 3 : vertices.size() / 3;
    _stats["cell_size"] = MAX(kMinCellSize, p_cell_size);
    _stats["energy"] = p_energy;
    _stats["budget"] = p_chunk_budget;
    return result;
}

int NewwoorldFracturer::estimate_chunk_count(const Ref<Mesh> &p_mesh, double p_energy,
        double p_cell_size) const {
    if (p_mesh.is_null() || p_mesh->get_surface_count() == 0) {
        return 0;
    }
    Array surface_arrays = p_mesh->surface_get_arrays(0);
    if (surface_arrays.size() <= Mesh::ARRAY_INDEX) {
        return 0;
    }
    PackedVector3Array vertices = surface_arrays[Mesh::ARRAY_VERTEX];
    PackedInt32Array indices = surface_arrays[Mesh::ARRAY_INDEX];
    if (vertices.size() < 3) {
        return 0;
    }

    Vector3 bounds_min;
    Vector3 bounds_max;
    _compute_bounds(vertices, bounds_min, bounds_max);
    const double cell = MAX(kMinCellSize, p_cell_size);

    // Оценка без построения геометрии: считаем, сколько разных вокселов
    // займут центроиды треугольников. Это верхняя граница — реальных
    // осколков может быть меньше, если часть вокселов пуста.
    std::unordered_map<int64_t, char> seen;
    const bool indexed = indices.size() >= 3;
    const int face_count = indexed ? (indices.size() / 3) : (vertices.size() / 3);
    const double energy_scale = 1.0 + Math::sqrt(MAX(0.0, p_energy)) * 0.02;

    for (int face = 0; face < face_count; face++) {
        const int i0 = indexed ? indices[face * 3 + 0] : face * 3 + 0;
        const int i1 = indexed ? indices[face * 3 + 1] : face * 3 + 1;
        const int i2 = indexed ? indices[face * 3 + 2] : face * 3 + 2;
        if (i0 >= vertices.size() || i1 >= vertices.size() || i2 >= vertices.size()) {
            continue;
        }
        const Vector3 centroid =
                (vertices[i0] + vertices[i1] + vertices[i2]) * (1.0 / 3.0);
        const Vector3i voxel(
                static_cast<int>(Math::floor((centroid.x - bounds_min.x) / cell)),
                static_cast<int>(Math::floor((centroid.y - bounds_min.y) / cell)),
                static_cast<int>(Math::floor((centroid.z - bounds_min.z) / cell)));
        seen.emplace(_voxel_key(voxel), 0);
    }
    const int raw = static_cast<int>(seen.size());
    return MIN(MIN(static_cast<int>(raw * energy_scale), kHardChunkCap), raw + 8);
}

Dictionary NewwoorldFracturer::last_statistics() const {
    return _stats;
}

int NewwoorldFracturer::last_chunk_count() const {
    return static_cast<int>(_chunks.size());
}

} // namespace newwoorld
