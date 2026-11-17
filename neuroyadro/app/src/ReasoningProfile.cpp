#include "ReasoningProfile.h"

#include <QtGlobal>

namespace {
int interpolate(const int from, const int to, const int value, const int low, const int high) {
    if (high == low) {
        return to;
    }
    return from + ((to - from) * (value - low)) / (high - low);
}
}

ReasoningProfile ReasoningProfile::fromStrength(const int requestedStrength) {
    ReasoningProfile profile;
    profile.strength = qBound(0, requestedStrength, 100);
    profile.sampling.temperature = 0.68F + (static_cast<float>(profile.strength) / 100.0F) * 0.12F;

    if (profile.strength == 0) {
        profile.label = QStringLiteral("Быстрый ответ");
        profile.detail = QStringLiteral("Без дополнительного внутреннего прохода");
        profile.sampling.temperature = 0.68F;
        return profile;
    }
    if (profile.strength < 10) {
        profile.thinkingTokenBudget = interpolate(16, 64, profile.strength, 1, 9);
        profile.label = QStringLiteral("Лёгкое обдумывание");
        profile.detail = QStringLiteral("1 вариант · поиск выключен");
        return profile;
    }
    if (profile.strength < 40) {
        profile.thinkingTokenBudget = interpolate(96, 256, profile.strength, 10, 39);
        profile.internalPasses = 1;
        profile.webSearchPermitted = true;
        profile.label = QStringLiteral("Обычное обдумывание");
        profile.detail = QStringLiteral("1 проход · локальный режим");
        return profile;
    }
    if (profile.strength < 70) {
        profile.thinkingTokenBudget = interpolate(320, 640, profile.strength, 40, 69);
        profile.internalPasses = 2;
        profile.candidates = 2;
        profile.webSearchPermitted = true;
        profile.label = QStringLiteral("Глубокое обдумывание");
        profile.detail = QStringLiteral("политика: 2 прохода · локальный режим");
        return profile;
    }
    profile.thinkingTokenBudget = interpolate(768, 1536, profile.strength, 70, 100);
    profile.internalPasses = 3;
    profile.candidates = 3;
    profile.webSearchPermitted = true;
    profile.sampling.temperature = 0.78F;
    profile.label = QStringLiteral("Максимальная глубина");
    profile.detail = QStringLiteral("политика: 3 прохода · локальный режим");
    return profile;
}
