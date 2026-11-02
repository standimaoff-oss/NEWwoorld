#ifndef NEWWOORLD_WIND_FIELD_H
#define NEWWOORLD_WIND_FIELD_H

#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/variant/packed_vector3_array.hpp>
#include <godot_cpp/variant/vector3.hpp>

// Типы движка живт в namespace godot; convention godot-cpp —
// раскрывать его в заголовке расширения (так сделаны все официальные
// примеры godotengine/godot-cpp-demo). Без этого Vector3/RefCounted
// в нашем namespace просто не видны.
using namespace godot;

namespace newwoorld {

/// NewwoorldWindField — пакетный расчёт поля ветра на CPU.
///
/// ЗАЧЕМ, ЕСЛИ ЕСТЬ ШЕЙДЕР. Шейдер качает вершины — это VISUAL. А физике
/// нужна СИЛА, приложенная к конкретному телу: ткань, осколки, летающие
/// объекты, ИИ-«нюх». Считать шум для 500 тел по одному вызову из GDScript
/// — 500 переходов через границу скрипт/движок за кадр. Этот класс считает
/// все 500 за ОДИН вызов и возвращает готовый PackedVector3Array.
///
/// Шум — октавный value noise с хешем на целочисленной решётке. Специально
/// без внешних зависимостей (SimplexNoise из Godot создаёт объект на вызов,
/// а здесь всё inline и без аллокаций).
class NewwoorldWindField : public RefCounted {
    GDCLASS(NewwoorldWindField, RefCounted)

public:
    NewwoorldWindField() = default;
    ~NewwoorldWindField() override = default;

    /// Направление ветра (единичный вектор).
    void set_direction(const Vector3 &p_direction);
    Vector3 get_direction() const { return _direction; }

    /// Базовая сила, условные м/с.
    void set_strength(double p_strength);
    double get_strength() const { return _strength; }

    /// Насколько сильны порывы поверх базовой силы, 0..1.
    void set_gustiness(double p_gustiness);
    double get_gustiness() const { return _gustiness; }

    /// Число октав шума. Больше = мельче завихрения = дороже.
    void set_octaves(int p_octaves);
    int get_octaves() const { return _octaves; }

    /// Пространственная частота шума.
    void set_frequency(double p_frequency);
    double get_frequency() const { return _frequency; }

    /// Мировое время. Двигается — поле живёт.
    void set_time(double p_time);
    double get_time() const { return _time; }

    /// Сид шума. Одинаковый сид = одинаковое поле: нужно для тестов и для
    /// воспроизведения записей.
    void set_seed_value(int p_seed);
    int get_seed_value() const { return _seed; }

    /// ГЛАВНЫЙ МЕТОД. Для каждой точки из p_positions возвращает вектор
    /// силы ветра. Пустой результат при несовпадении размеров невозможен:
    /// выходной массив всегда равен входному.
    PackedVector3Array sample_batch(const PackedVector3Array &p_positions) const;

    /// Сила ветра в одной точке — удобно из GDScript для разовых запросов.
    Vector3 sample(const Vector3 &p_position) const;

    /// Завихренность (скаляр 0..1) в точке. Нужна эффектам: пыль и дым
    /// у турбулентного ветра ведутся иначе, чем у ламинарного.
    double turbulence_at(const Vector3 &p_position) const;

protected:
    static void _bind_methods();

private:
    /// Хеш целочисленной точки решётки -> псевдослучайное значение -1..1.
    double _hash(int p_x, int p_y, int p_z) const;
    /// Трилинейная интерполяция хешей: непрерывный шум из дискретной решётки.
    double _value_noise(const Vector3 &p_point) const;
    /// Сумма октав с убывающей амплитудой и возрастающей частотой (fBm).
    double _fbm(const Vector3 &p_point) const;

    Vector3 _direction = Vector3(0, 0, -1);
    double _strength = 2.0;
    double _gustiness = 0.85;
    int _octaves = 3;
    double _frequency = 0.35;
    double _time = 0.0;
    int _seed = 1337;
};

} // namespace newwoorld

#endif // NEWWOORLD_WIND_FIELD_H
