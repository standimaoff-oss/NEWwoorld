cmake_minimum_required(VERSION 3.21)
project(NeuroYadro VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

option(NEUROYADRO_WITH_LLAMA "Build the in-process llama.cpp GGUF runtime" ON)
set(NEUROYADRO_LLAMA_CPP_DIR "" CACHE PATH "Path to a compatible llama.cpp checkout")

find_package(Qt6 6.5 REQUIRED COMPONENTS Core Gui Qml Quick QuickControls2 Sql)
qt_standard_project_setup(REQUIRES 6.5)

set(NEUROYADRO_SOURCES
    src/main.cpp
    src/ChatTypes.h
    src/ChatStorage.h src/ChatStorage.cpp
    src/ChatListModel.h src/ChatListModel.cpp
    src/MessageListModel.h src/MessageListModel.cpp
    src/ReasoningProfile.h src/ReasoningProfile.cpp
    src/ClarificationParser.h src/ClarificationParser.cpp
    src/ContextPlanner.h src/ContextPlanner.cpp
    src/LlamaWorker.h src/LlamaWorker.cpp
    src/ChatController.h src/ChatController.cpp
)

qt_add_executable(NeuroYadro ${NEUROYADRO_SOURCES})
qt_add_qml_module(NeuroYadro
    URI NeuroYadro
    VERSION 1.0
    QML_FILES qml/Main.qml
)
# qt_add_qml_module creates a URI-named directory. Keep the executable below bin/ so its
# filename never collides with the QML module directory on case-sensitive build hosts.
set_target_properties(NeuroYadro PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)

target_link_libraries(NeuroYadro PRIVATE
    Qt6::Core Qt6::Gui Qt6::Qml Qt6::Quick Qt6::QuickControls2 Qt6::Sql
)

target_compile_definitions(NeuroYadro PRIVATE
    QT_NO_CAST_FROM_ASCII
    QT_NO_CAST_TO_ASCII
)

# llama.cpp is intentionally an external dependency: model/runtime updates stay independent
# of UI history.  If not supplied, the application still builds and clearly reports that it
# cannot load a model; it never substitutes a canned answer.
if (NEUROYADRO_WITH_LLAMA)
    if (NOT NEUROYADRO_LLAMA_CPP_DIR)
        message(STATUS "llama.cpp directory not set: building UI/storage without GGUF runtime")
    elseif (NOT EXISTS "${NEUROYADRO_LLAMA_CPP_DIR}/CMakeLists.txt")
        message(FATAL_ERROR "NEUROYADRO_LLAMA_CPP_DIR is not a llama.cpp source directory")
    else()
        set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
        set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
        add_subdirectory("${NEUROYADRO_LLAMA_CPP_DIR}" "${CMAKE_BINARY_DIR}/llama.cpp" EXCLUDE_FROM_ALL)
        target_link_libraries(NeuroYadro PRIVATE llama)
        target_compile_definitions(NeuroYadro PRIVATE NEUROYADRO_WITH_LLAMA=1)
    endif()
endif()

# Android receives a package name, launcher metadata and optional release signing only when
# the CI/maintainer supplies all keystore values.  A stable tag must never publish an unsigned APK.
if (ANDROID)
    set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_PACKAGE_SOURCE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/android")
    set(NEUROYADRO_ANDROID_SIGNING_VALUES
        NEUROYADRO_ANDROID_KEYSTORE_PATH
        NEUROYADRO_ANDROID_KEYSTORE_ALIAS
        NEUROYADRO_ANDROID_KEYSTORE_STORE_PASSWORD
        NEUROYADRO_ANDROID_KEYSTORE_KEY_PASSWORD
    )
    set(NEUROYADRO_ANDROID_SIGNING_COUNT 0)
    foreach (value IN LISTS NEUROYADRO_ANDROID_SIGNING_VALUES)
        if (DEFINED ${value} AND NOT "${${value}}" STREQUAL "")
            math(EXPR NEUROYADRO_ANDROID_SIGNING_COUNT "${NEUROYADRO_ANDROID_SIGNING_COUNT} + 1")
        endif()
    endforeach()
    if (NEUROYADRO_ANDROID_SIGNING_COUNT GREATER 0 AND NOT NEUROYADRO_ANDROID_SIGNING_COUNT EQUAL 4)
        message(FATAL_ERROR "Set all NEUROYADRO_ANDROID_KEYSTORE_* values or none of them")
    endif()
    if (NEUROYADRO_ANDROID_SIGNING_COUNT EQUAL 4)
        set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_SIGN_APK ON)
        set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_KEYSTORE_PATH "${NEUROYADRO_ANDROID_KEYSTORE_PATH}")
        set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_KEYSTORE_ALIAS "${NEUROYADRO_ANDROID_KEYSTORE_ALIAS}")
        set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_KEYSTORE_STORE_PASS "${NEUROYADRO_ANDROID_KEYSTORE_STORE_PASSWORD}")
        set_property(TARGET NeuroYadro PROPERTY QT_ANDROID_KEYSTORE_KEY_PASS "${NEUROYADRO_ANDROID_KEYSTORE_KEY_PASSWORD}")
    endif()
endif()

qt_finalize_executable(NeuroYadro)

include(GNUInstallDirs)
install(TARGETS NeuroYadro
    BUNDLE DESTINATION .
    RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR}
    LIBRARY DESTINATION ${CMAKE_INSTALL_LIBDIR}
)
