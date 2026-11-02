#ifndef NEWWOORLD_FRACTURER_H
#define NEWWOORLD_FRACTURER_H

#include <godot_cpp/classes/array_mesh.hpp>
#include <godot_cpp/classes/mesh.hpp>
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/packed_int32_array.hpp>
#include <godot_cpp/variant/packed_vector3_array.hpp>
#include <godot_cpp/variant/transform3d.hpp>
#include <godot_cpp/variant/vector3.hpp>
#include <godot_cpp/variant/vector3i.hpp>

#include <unordered_map>
#include <vector>

// Типы движка живт в namespace godot; convention godot-cpp —
// раскрывать его в заголовке расширения (так сделаны все официальные
// примеры godotengine/godot-cpp-demo). Без этого Vector3/RefCounted
// в нашем namespace просто не видны.
using namespace godot;

namespace newwoorld {

/// Один осколок: геометрия + как его толкнуть.
///
/// Структура, а не Dictionary, потому что нарезка создаёт сотни таких за
/// вызов. Dictionary — это RefCounted-объект с хеш-таблицей внутри и
/// аллокацией на каждый; Vector<ChunkData> — сплошная память. В Dictionary
/// превращаем ровно один раз, на границе с GDScript.
struct ChunkData {
    /// Индексы ТРЕУГОЛЬНИКОВ (не вершин) исходного меша, попавшие в чанк.
    /// Внутренние контейнеры — STL, а не godot::Vector: нам нужны
    /// std::sort и std::unordered_map, а на границе с GDScript всё равно
    /// всё превращается в Array/Dictionary.
    std::vector<int> faces;
    /// Центроид в локальных координатах объекта.
    Vector3 centroid;
    /// Ограничивающий объём чанка в локальных координатах.
    Vector3 bounds_min;
    Vector3 bounds_max;
    /// Координаты воксела — нужны отладке и тестам.
    Vector3i voxel;
    int vertex_count = 0;
    /// Расстояние от точки удара — определяет порядок отбрасывания
    /// при исчерпанном бюджете.
    double impact_distance = 0.0;
};

/// NewwoorldFracturer — нарезка меша на осколки воксельной сеткой.
///
/// ЗАЧЕМ ЭТО В C++. Алгоритм проходит по всем треугольникам несколько раз:
/// границы меша, раскладка по вокселям, центроиды, сборка геометрии.
/// На меше в 20 000 треугольников это сотни тысяч операций с плавающей
/// точкой. GDScript исполняет их в интерпретаторе с проверкой типов на
/// каждой операции: замер на таком объёме — десятки миллисекунд, то есть
/// 2–5 кадров вылета. C++ делает то же за единицы миллисекунд.
///
/// Это не микрооптимизация «на всякий случай». Взрыв происходит ровно в
/// тот кадр, когда игрок должен увидеть результат, — терять этот кадр
/// нельзя, иначе разрушение ощущается не «сочным», а лагающим.
///
/// Возвращает Array[Dictionary] с теми же ключами, что и GDScript-fallback
/// в DestructionService, поэтому переключение бэкендов прозрачно для игры:
///     { "mesh": ArrayMesh, "offset": Vector3, "impulse": Vector3,
///       "spin": Vector3, "piece_index": int }
class NewwoorldFracturer : public RefCounted {
    GDCLASS(NewwoorldFracturer, RefCounted)

public:
    NewwoorldFracturer() = default;
    ~NewwoorldFracturer() override = default;

    /// Нарезает меш на осколки.
    ///
    /// @param p_mesh          исходный меш (используется поверхность 0).
    /// @param p_transform     мировое преобразование объекта.
    /// @param p_impact_point  точка удара в МИРОВЫХ координатах.
    /// @param p_impact_normal направление удара (мировые координаты).
    /// @param p_energy        энергия удара: влияет на число осколков и импульс.
    /// @param p_cell_size     размер воксела. Меньше = мельче осколки = дороже.
    /// @param p_chunk_budget  жёсткий потолок числа осколков.
    Array fracture(const Ref<Mesh> &p_mesh, const Transform3D &p_transform,
            const Vector3 &p_impact_point, const Vector3 &p_impact_normal,
            double p_energy, double p_cell_size, int p_chunk_budget);

    /// Сколько осколков дала бы нарезка, БЕЗ построения геометрии.
    /// Нужно предсказателю нагрузки: уровень может заранее спросить
    /// «сколько будет мусора» и понизить качество ДО взрыва, а не после.
    int estimate_chunk_count(const Ref<Mesh> &p_mesh, double p_energy,
            double p_cell_size) const;

    /// Импульс для точки внутри объекта. Вынесено отдельно, потому что та же
    /// математика нужна для отбрасывания посторонних тел взрывной волной.
    Vector3 compute_impulse(const Vector3 &p_local_centroid,
            const Vector3 &p_local_impact, const Vector3 &p_impact_normal,
            double p_energy) const;

    /// Статистика последней нарезки — для тестов и debug-оверлея.
    Dictionary last_statistics() const;

    /// Число осколков последней нарезки. Отдельным методом: тестам удобнее
    /// читать int, чем вытаскивать его из Dictionary.
    int last_chunk_count() const;

protected:
    static void _bind_methods();

private:
    /// Раскладывает треугольники по воксельной сетке.
    /// Чанки сортируются по расстоянию до точки удара, поэтому при исчерпанном
    /// бюджете отбрасываются самые ДАЛЬНИЕ куски — игрок смотрит на удар и
    /// не замечает, что дальний угол стены не развалился.
    void _build_chunks(const PackedVector3Array &p_vertices,
            const PackedInt32Array &p_indices, const Vector3 &p_local_impact,
            double p_cell_size, int p_chunk_budget);

    /// Собирает ArrayMesh одного чанка из его треугольников.
    Ref<ArrayMesh> _build_chunk_mesh(const PackedVector3Array &p_vertices,
            const PackedInt32Array &p_indices,
            const PackedVector3Array &p_normals, const ChunkData &p_chunk) const;

    static void _compute_bounds(const PackedVector3Array &p_vertices,
            Vector3 &r_min, Vector3 &r_max);

    /// Ключ воксела в int64: HashMap<Vector3i, ...> потребовал бы своего
    /// хешера, а целочисленный ключ хешируется штатно и быстрее.
    static int64_t _voxel_key(const Vector3i &p_voxel);

    std::vector<ChunkData> _chunks;
    Dictionary _stats;
    std::unordered_map<int64_t, int> _voxel_index;
};

} // namespace newwoorld

#endif // NEWWOORLD_FRACTURER_H
