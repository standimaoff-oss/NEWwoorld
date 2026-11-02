#include "register_types.h"

#include <gdextension_interface.h>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/memory.hpp>
#include <godot_cpp/godot.hpp>

#include "newwoorld_fracturer.h"
#include "newwoorld_wind_field.h"

using namespace godot;
using namespace newwoorld;

void initialize_newwoorld_module(ModuleInitializationLevel p_level) {
    // Классы регистрируем на уровне SCENE, а не CORE: им нужен доступ к
    // дереву сцены и ресурсам, на уровне CORE их ещё нет.
    if (p_level != MODULE_INITIALIZATION_LEVEL_SCENE) {
        return;
    }
    ClassDB::register_class<NewwoorldFracturer>();
    ClassDB::register_class<NewwoorldWindField>();

    // Пишем в лог движка: при запуске сразу видно, что расширение живо
    // и какой у него бэкенд. Без этой строки «C++ не подключился» и
    // «C++ подключился, но молчит» выглядят одинаково.
    UtilityFunctions::print("[NEWwoorld] C++ GDExtension загружен: ",
            "NewwoorldFracturer, NewwoorldWindField");
}

void uninitialize_newwoorld_module(ModuleInitializationLevel p_level) {
    if (p_level != MODULE_INITIALIZATION_LEVEL_SCENE) {
        return;
    }
    // Классы снимать с регистрации не нужно: ClassDB чистит их сам
    // при выгрузке библиотеки. Здесь — только наши побочные ресурсы.
}

/// Точка входа, на которую ссылается entry_symbol в newwoorld.gdextension.
/// Имя ОБЯЗАНО совпадать с тем, что указано в .gdextension, иначе движок
/// загрузит библиотеку, не найдёт символ и молча отключит расширение.
extern "C" GDExtensionBool GDE_EXPORT newwoorld_library_init(
        GDExtensionInterfaceGetProcAddress p_get_proc_address,
        GDExtensionClassLibraryPtr p_library, GDExtensionInitialization *r_initialization) {
    GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);

    init_obj.register_initializer(initialize_newwoorld_module);
    init_obj.register_terminator(uninitialize_newwoorld_module);
    init_obj.set_minimum_library_initialization_level(MODULE_INITIALIZATION_LEVEL_SCENE);

    return init_obj.init();
}
