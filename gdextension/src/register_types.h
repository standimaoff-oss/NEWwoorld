#ifndef NEWWOORLD_REGISTER_TYPES_H
#define NEWWOORLD_REGISTER_TYPES_H

#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/godot.hpp>

using namespace godot;

/// Регистрация классов расширения. Вызывается движком при загрузке.
void initialize_newwoorld_module(ModuleInitializationLevel p_level);

/// Обратная очистка. Обязательна: без неё hot-reload расширения в редакторе
/// оставляет «призрачные» классы и редактор падает при пересборке.
void uninitialize_newwoorld_module(ModuleInitializationLevel p_level);

#endif // NEWWOORLD_REGISTER_TYPES_H
