#pragma once

#include <QString>

struct SamplingSettings {
    float temperature = 0.70F;
    float topP = 0.90F;
    float minP = 0.05F;
    float repetitionPenalty = 1.12F;
    int repeatWindow = 64;
};

struct ReasoningProfile {
    int strength = 0;
    int thinkingTokenBudget = 0;
    int internalPasses = 0;
    int candidates = 1;
    bool webSearchPermitted = false;
    SamplingSettings sampling;
    QString label;
    QString detail;

    static ReasoningProfile fromStrength(int strength);
};
