# ============================================================================
#  NEWwoorld — C++ GDExtension, альтернативная сборка через CMake
# ============================================================================
#
#  ВНИМАНИЕ: ЭТОТ ФАЙЛ НЕ ПРОВЕРЕН СБОРКОЙ.
#
#  В среде, где он написан, cmake отсутствует (есть только gcc/g++, make,
#  python3, node). Поэтому файл сверен с ИСХОДНИКАМИ godot-cpp
#  (cmake/godotcpp.cmake, cmake/GodotCPPModule.cmake), а не с результатом
#  запуска. Проверено по исходникам:
#
#    · цель godot-cpp создаётся как STATIC и имеет алиас godot::cpp
#      (cmake/godotcpp.cmake:338 и :345);
#    · include-каталоги объявлены PUBLIC: include,
#      ${CMAKE_CURRENT_BINARY_DIR}/gen/include и ${GODOTCPP_GDEXTENSION_DIR}
#      (cmake/godotcpp.cmake:351) — то есть подключать их вручную НЕ нужно;
#    · CXX_STANDARD 17, POSITION_INDEPENDENT_CODE ON (там же, :360);
#    · переменные GODOTCPP_TARGET / GODOTCPP_PRECISION / GODOTCPP_THREADS /
#      GODOTCPP_DEV_BUILD / GODOTCPP_DISABLE_EXCEPTIONS / GODOTCPP_SUFFIX
#      существуют и кэшируются (cmake/godotcpp.cmake:109-177, :335).
#
#  НЕ проверено: фактическая компоновка и имена файлов на каждой платформе.
#  Первый запуск нужно делать в CI (см. .github/workflows/godot-ci.yml,
#  задание cmake-smoke) — оно собирает проект и сверяет имя результата
#  с тем, что объявлено в game/bin/newwoorld.gdextension.
#
#  КАНОНИЧНАЯ СБОРКА — SCONS (gdextension/SConstruct). godot-cpp официально
#  собирается им, и его SConstruct сам разруливает кросс-компиляцию и флаги
#  ABI. CMake здесь — для IDE (CLion, VS Code, Visual Studio), которым нужен
#  compilation database и нормальная навигация по коду.
#
#  РАСХОЖДЕНИЕ МЕЖДУ ЭТИМИ ДВУМЯ ПУТЯМИ ОПАСНО: расширение, собранное с
#  другими флагами ABI, чем ждёт движок, загружается молча неверно или не
#  загружается вовсе. Поэтому опции ниже по умолчанию повторяют scons,
#  а не выбирают «удобные» значения.
#
# ----------------------------------------------------------------------------
#  ИСПОЛЬЗОВАНИЕ
#
#    cmake -S gdextension -B build -DGODOTCPP_TARGET=template_debug
#    cmake --build build -j 8
#
#  Переключаемые опции (все — из godot-cpp, значения те же, что у scons):
#
#    -DGODOTCPP_TARGET=template_debug|template_release|editor
#    -DGODOTCPP_PRECISION=single|double      # double — только для
#                                            # double-precision сборок Godot
#    -DGODOTCPP_THREADS=ON|OFF
#    -DGODOTCPP_DEV_BUILD=ON|OFF             # assertions, медленнее
#    -DCMAKE_BUILD_TYPE=Debug|Release|RelWithDebInfo
#
#  Результат кладётся в ../game/bin/ — то есть в res://bin/ внутри проекта,
#  потому что .gdextension умеет ссылаться только на пути внутри res://.
# ============================================================================

cmake_minimum_required(VERSION 3.22)

project(
    newwoorld
    VERSION 0.1.0
    DESCRIPTION "NEWwoorld C++ GDExtension (fracturing + wind field)"
    LANGUAGES CXX
)

# ----------------------------------------------------------------------------
#  Проверка подмодуля ДО add_subdirectory.
#
#  Без неё cmake выдаёт «add_subdirectory given source ... which is not an
#  existing directory» — сообщение, из которого неочевидно, что забыт
#  git submodule update --init.
# ----------------------------------------------------------------------------
set(NEWWOORLD_GODOT_CPP "${CMAKE_CURRENT_SOURCE_DIR}/godot-cpp")

if(NOT EXISTS "${NEWWOORLD_GODOT_CPP}/CMakeLists.txt")
    message(FATAL_ERROR
        "godot-cpp не найден в ${NEWWOORLD_GODOT_CPP}\n"
        "Это git-подмодуль. Выполните:\n"
        "    git submodule update --init --recursive\n"
        "или запустите  bash tools/setup/setup.sh")
endif()

# ----------------------------------------------------------------------------
#  Опции godot-cpp. Задаются ДО add_subdirectory, потому что внутри
#  godotcpp_options() они объявляются как CACHE — повторная установка после
#  подключения подкаталога уже ни на что не повлияет.
# ----------------------------------------------------------------------------
if(NOT DEFINED GODOTCPP_TARGET)
    set(GODOTCPP_TARGET "template_debug" CACHE STRING
        "Цель сборки Godot (template_debug|template_release|editor)" FORCE)
endif()

# Точность float ОБЯЗАНА совпадать с точностью сборки движка, иначе ABI
# расходится и расширение падает при загрузке.
if(NOT DEFINED GODOTCPP_PRECISION)
    set(GODOTCPP_PRECISION "single" CACHE STRING
        "Точность чисел с плавающей точкой (single|double)" FORCE)
endif()

# Исключения в GDExtension запрещены по умолчанию (GODOTCPP_DISABLE_EXCEPTIONS=ON
# в самом godot-cpp). Оставляем как есть.
#
# RTTI отключать НЕЛЬЗЯ. godot::Object::cast_to<T>() внутри godot-cpp
# реализован через dynamic_cast (include/godot_cpp/core/object.hpp:133).
# С -fno-rtti код компилируется, но cast_to возвращает мусор или падает в
# рантайме — дефект, который выглядит как «движок сломался».
# Поэтому ниже RTTI не трогаем ни явно, ни через опции.

if(NOT DEFINED CMAKE_BUILD_TYPE AND NOT DEFINED CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE "Debug" CACHE STRING "Тип сборки" FORCE)
    set_property(CACHE CMAKE_BUILD_TYPE PROPERTY STRINGS
        Debug Release RelWithDebInfo MinSizeRel)
endif()

add_subdirectory(godot-cpp EXCLUDE_FROM_ALL)

# ----------------------------------------------------------------------------
#  Наша библиотека
# ----------------------------------------------------------------------------
add_library(newwoorld SHARED
    src/register_types.cpp
    src/newwoorld_fracturer.cpp
    src/newwoorld_wind_field.cpp
)

# Файлы перечислены явно, а не через GLOB. GLOB не отслеживает появление
# нового .cpp: сборка «пройдёт успешно» без нового файла, и расширение
# окажется без части классов — с ошибкой уже в игре, а не в компиляторе.
set_target_properties(newwoorld PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
    CXX_EXTENSIONS OFF
)

target_include_directories(newwoorld PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# godot::cpp объявляет include-каталоги как PUBLIC, поэтому достаточно
# связать цель — пути подтянутся сами.
target_link_libraries(newwoorld PRIVATE godot::cpp)

# ----------------------------------------------------------------------------
#  Имя и расположение результата.
#
#  Шаблон ОБЯЗАН совпадать с game/bin/newwoorld.gdextension:
#      libnewwoorld.<platform>.<target>[.dev][.double].<arch><расширение>
#
#  GODOTCPP_SUFFIX — генераторное выражение из godot-cpp, уже содержащее
#  платформу, таргет и архитектуру. Используем его, а не собираем строку
#  вручную: расхождение суффикса — самая частая причина «расширение
#  собралось, но игра его не видит».
# ----------------------------------------------------------------------------
set_target_properties(newwoorld PROPERTIES
    PREFIX "lib"
    OUTPUT_NAME "newwoorld${GODOTCPP_SUFFIX}"
    LIBRARY_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../game/bin"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../game/bin"
    ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../game/bin"
)

# macOS: расширение Godot — это .dylib, а CMake по умолчанию даёт
# libnewwoorld.<suffix>.dylib только при явно включённом SHARED. Дополнительно
# для universal-сборки (x86_64 + arm64 в одном файле) scons вызывает
# lipo вручную; CMake этого не делает, поэтому universal-сборка через CMake
# НЕ поддерживается — для macOS используйте scons.
if(APPLE)
    message(WARNING
        "Сборка macOS через CMake не создаёт universal-библиотеку. "
        "Для .gdextension нужен один файл на x86_64 и arm64 — используйте "
        "scons: cd gdextension && scons platform=macos arch=universal")
endif()

# ----------------------------------------------------------------------------
#  Печать итога: куда лёг файл и что его ищет.
#  «Собралось, но не там, где ищет проект» — одна из самых частых и самых
#  непонятных проблем с GDExtension.
# ----------------------------------------------------------------------------
add_custom_command(TARGET newwoorld POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E echo
        "[newwoorld] цель: $<TARGET_FILE_NAME:newwoorld>"
    COMMAND ${CMAKE_COMMAND} -E echo
        "[newwoorld] каталог: ${CMAKE_CURRENT_SOURCE_DIR}/../game/bin"
    COMMAND ${CMAKE_COMMAND} -E echo
        "[newwoorld] объявлено в res://bin/newwoorld.gdextension"
)

message(STATUS "newwoorld: GODOTCPP_TARGET=${GODOTCPP_TARGET}, "
               "GODOTCPP_PRECISION=${GODOTCPP_PRECISION}, "
               "CMAKE_BUILD_TYPE=${CMAKE_BUILD_TYPE}")
