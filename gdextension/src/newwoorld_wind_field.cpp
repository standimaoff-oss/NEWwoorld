#include "newwoorld_wind_field.h"

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/math.hpp>

#include <cmath>

using namespace godot;

namespace newwoorld {

namespace {
/// Время в шумовом пространстве течёт медленнее мирового: иначе порывы
/// мельтешат, и ветер выглядит как вибрация, а не как поток воздуха.
constexpr double kTimeScale = 0.35;
/// Потолок силы. Больше — физика начинает выбрасывать тела за пределы мира.
constexpr double kMaxStrength = 25.0;
constexpr int kMaxOctaves = 6;

/// Смешивание через кубическую кривую (smoothstep). Линейная интерполяция
/// хешей даёт видимую «сетку» на поле ветра: объекты качаются синхронно
/// по границам вокселов шума. Кубическая — убирает это почти бесплатно.
inline double _smooth(double p_t) {
    return p_t * p_t * (3.0 - 2.0 * p_t);
}
} // namespace

void NewwoorldWindField::_bind_methods() {
    ClassDB::bind_method(D_METHOD("set_direction", "direction"),
            &NewwoorldWindField::set_direction);
    ClassDB::bind_method(D_METHOD("get_direction"), &NewwoorldWindField::get_direction);
    ADD_PROPERTY(PropertyInfo(Variant::VECTOR3, "direction"), "set_direction",
            "get_direction");

    ClassDB::bind_method(D_METHOD("set_strength", "strength"),
            &NewwoorldWindField::set_strength);
    ClassDB::bind_method(D_METHOD("get_strength"), &NewwoorldWindField::get_strength);
    ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "strength"), "set_strength", "get_strength");

    ClassDB::bind_method(D_METHOD("set_gustiness", "gustiness"),
            &NewwoorldWindField::set_gustiness);
    ClassDB::bind_method(D_METHOD("get_gustiness"), &NewwoorldWindField::get_gustiness);
    ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "gustiness"), "set_gustiness",
            "get_gustiness");

    ClassDB::bind_method(D_METHOD("set_octaves", "octaves"), &NewwoorldWindField::set_octaves);
    ClassDB::bind_method(D_METHOD("get_octaves"), &NewwoorldWindField::get_octaves);
    ADD_PROPERTY(PropertyInfo(Variant::INT, "octaves"), "set_octaves", "get_octaves");

    ClassDB::bind_method(D_METHOD("set_frequency", "frequency"),
            &NewwoorldWindField::set_frequency);
    ClassDB::bind_method(D_METHOD("get_frequency"), &NewwoorldWindField::get_frequency);
    ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "frequency"), "set_frequency", "get_frequency");

    ClassDB::bind_method(D_METHOD("set_time", "time"), &NewwoorldWindField::set_time);
    ClassDB::bind_method(D_METHOD("get_time"), &NewwoorldWindField::get_time);
    ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "time"), "set_time", "get_time");

    ClassDB::bind_method(D_METHOD("set_seed_value", "seed_value"),
            &NewwoorldWindField::set_seed_value);
    ClassDB::bind_method(D_METHOD("get_seed_value"), &NewwoorldWindField::get_seed_value);
    ADD_PROPERTY(PropertyInfo(Variant::INT, "seed_value"), "set_seed_value",
            "get_seed_value");

    ClassDB::bind_method(D_METHOD("sample_batch", "positions"),
            &NewwoorldWindField::sample_batch);
    ClassDB::bind_method(D_METHOD("sample", "position"), &NewwoorldWindField::sample);
    ClassDB::bind_method(D_METHOD("turbulence_at", "position"),
            &NewwoorldWindField::turbulence_at);
}

void NewwoorldWindField::set_direction(const Vector3 &p_direction) {
    // Ненормированный вектор направления — частая ошибка уровня: ветер
    // внезапно становится втрое сильнее. Нормируем на входе.
    _direction = p_direction.length_squared() > 0.000001
            ? p_direction.normalized()
            : Vector3(0, 0, -1);
}

void NewwoorldWindField::set_strength(double p_strength) {
    _strength = CLAMP(p_strength, 0.0, kMaxStrength);
}

void NewwoorldWindField::set_gustiness(double p_gustiness) {
    _gustiness = CLAMP(p_gustiness, 0.0, 1.0);
}

void NewwoorldWindField::set_octaves(int p_octaves) {
    _octaves = CLAMP(p_octaves, 1, kMaxOctaves);
}

void NewwoorldWindField::set_frequency(double p_frequency) {
    // Ноль или отрицательная частота дали бы деление на ноль в шуме.
    _frequency = MAX(0.0001, p_frequency);
}

void NewwoorldWindField::set_time(double p_time) {
    _time = p_time;
}

void NewwoorldWindField::set_seed_value(int p_seed) {
    _seed = p_seed;
}

double NewwoorldWindField::_hash(int p_x, int p_y, int p_z) const {
    // Целочисленный хеш. Быстрый, без синусов (синусные хеши дают видимые
    // диагональные полосы на больших координатах — классический артефакт).
    uint64_t h = static_cast<uint64_t>(static_cast<uint32_t>(p_x));
    h = h * 374761393ULL + static_cast<uint64_t>(static_cast<uint32_t>(p_y)) * 668265263ULL;
    h = (h ^ (h >> 13)) * 1274126177ULL;
    h = h ^ (h >> 16);
    h += static_cast<uint64_t>(static_cast<uint32_t>(p_z)) * 2246822519ULL;
    h = (h ^ (h >> 15)) * 3266489917ULL;
    h ^= (h >> 13);
    h += static_cast<uint64_t>(static_cast<uint32_t>(_seed));
    h = (h ^ (h >> 17)) * 668265263ULL;
    h ^= h >> 19;
    return (static_cast<double>(h & 0xFFFFFFFFULL) / 2147483647.5) - 1.0;
}

double NewwoorldWindField::_value_noise(const Vector3 &p_point) const {
    const int xi = static_cast<int>(Math::floor(p_point.x));
    const int yi = static_cast<int>(Math::floor(p_point.y));
    const int zi = static_cast<int>(Math::floor(p_point.z));
    const double tx = _smooth(p_point.x - static_cast<double>(xi));
    const double ty = _smooth(p_point.y - static_cast<double>(yi));
    const double tz = _smooth(p_point.z - static_cast<double>(zi));

    // Восемь углов ячейки решётки.
    const double c000 = _hash(xi, yi, zi);
    const double c100 = _hash(xi + 1, yi, zi);
    const double c010 = _hash(xi, yi + 1, zi);
    const double c110 = _hash(xi + 1, yi + 1, zi);
    const double c001 = _hash(xi, yi, zi + 1);
    const double c101 = _hash(xi + 1, yi, zi + 1);
    const double c011 = _hash(xi, yi + 1, zi + 1);
    const double c111 = _hash(xi + 1, yi + 1, zi + 1);

    const double x00 = Math::lerp(c000, c100, tx);
    const double x10 = Math::lerp(c010, c110, tx);
    const double x01 = Math::lerp(c001, c101, tx);
    const double x11 = Math::lerp(c011, c111, tx);
    const double y0 = Math::lerp(x00, x10, ty);
    const double y1 = Math::lerp(x01, x11, ty);
    return Math::lerp(y0, y1, tz);
}

double NewwoorldWindField::_fbm(const Vector3 &p_point) const {
    double amplitude = 1.0;
    double frequency = 1.0;
    double sum = 0.0;
    double norm = 0.0;
    for (int i = 0; i < _octaves; i++) {
        sum += amplitude * _value_noise(p_point * frequency);
        norm += amplitude;
        amplitude *= 0.5;
        frequency *= 2.0;
    }
    // Нормируем, чтобы результат оставался в -1..1 независимо от числа октав.
    // Без этого добавление октавы «усиливало» ветер, и настройка качества
    // меняла не детализацию, а геймплей.
    return norm > 0.0 ? sum / norm : 0.0;
}

Vector3 NewwoorldWindField::sample(const Vector3 &p_position) const {
    if (_strength <= 0.0) {
        return Vector3();
    }
    // Время добавляется в z-координату шумового пространства: поле «едет»
    // сквозь мир, а не мигает на месте.
    const Vector3 noise_point = p_position * _frequency
            + Vector3(0, 0, _time * kTimeScale);
    const double gust = _fbm(noise_point);
    // Порыв — только положительная половина шума: ветер не должен «сосать»
    // объекты назад, это читается как баг физики.
    const double gust_factor = 1.0 + MAX(0.0, gust) * _gustiness * 2.0;

    // Боковое завихрение берём из шума со смещённой точкой, иначе все тела
    // летели бы строго по одному вектору — выглядит как конвейер, а не ветер.
    const Vector3 swirl_point = noise_point + Vector3(17.3, 5.1, 11.7);
    const double swirl = _fbm(swirl_point) * _gustiness * 0.35;
    const Vector3 side = _direction.cross(Vector3(0, 1, 0)).normalized();
    const Vector3 up_bend = Vector3(0, 1, 0) * (swirl * 0.5);

    return (_direction + side * swirl + up_bend).normalized() * (_strength * gust_factor);
}

double NewwoorldWindField::turbulence_at(const Vector3 &p_position) const {
    const Vector3 noise_point = p_position * _frequency
            + Vector3(0, 0, _time * kTimeScale);
    // Берём три смещённые пробы и считаем разброс — дешёвая оценка
    // градиента без явного дифференцирования шума.
    const double a = _fbm(noise_point);
    const double b = _fbm(noise_point + Vector3(0.5, 0, 0));
    const double c = _fbm(noise_point + Vector3(0, 0.5, 0));
    const double spread = Math::abs(a - b) + Math::abs(a - c);
    return CLAMP(spread, 0.0, 1.0);
}

PackedVector3Array NewwoorldWindField::sample_batch(
        const PackedVector3Array &p_positions) const {
    const int count = p_positions.size();
    PackedVector3Array out;
    if (count == 0) {
        return out;
    }
    out.resize(count);

    // Быстрый путь: ветер выключен — не считаем шум вообще. Шум дороже
    // самой записи в массив раз в двадцать.
    if (_strength <= 0.0) {
        for (int i = 0; i < count; i++) {
            out[i] = Vector3();
        }
        return out;
    }

    // Один вызов из GDScript вместо N — главная причина существования
    // этого класса: каждый переход скрипт/движок стоит дороже самого
    // расчёта шума на одну точку.
    for (int i = 0; i < count; i++) {
        out[i] = sample(p_positions[i]);
    }
    return out;
}

} // namespace newwoorld
