#include "ClarificationParser.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QVariantMap>

namespace {
constexpr int MaxQuestions = 3;
constexpr int MaxOptions = 3;
constexpr int MaxQuestionLength = 500;
constexpr int MaxOptionLength = 240;

bool boundedText(const QString &value, const int limit) {
    return !value.trimmed().isEmpty() && value.size() <= limit;
}
}

QVariantList ClarificationParser::parse(const QString &content) {
    const QByteArray json = content.trimmed().toUtf8();
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(json, &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) {
        return {};
    }
    const QJsonValue candidate = document.object().value(QStringLiteral("clarify"));
    if (!candidate.isArray()) {
        return {};
    }
    const QJsonArray source = candidate.toArray();
    if (source.isEmpty() || source.size() > MaxQuestions) {
        return {};
    }

    QVariantList result;
    for (const QJsonValue &entry : source) {
        if (!entry.isObject()) {
            return {};
        }
        const QJsonObject item = entry.toObject();
        const QString question = item.value(QStringLiteral("question")).toString().trimmed();
        const QJsonValue optionsValue = item.value(QStringLiteral("options"));
        if (!boundedText(question, MaxQuestionLength) || !optionsValue.isArray()) {
            return {};
        }
        const QJsonArray sourceOptions = optionsValue.toArray();
        if (sourceOptions.isEmpty() || sourceOptions.size() > MaxOptions) {
            return {};
        }
        QVariantList options;
        for (const QJsonValue &optionValue : sourceOptions) {
            const QString option = optionValue.toString().trimmed();
            if (!boundedText(option, MaxOptionLength)) {
                return {};
            }
            options.append(option);
        }
        QVariantMap safe;
        safe.insert(QStringLiteral("question"), question);
        safe.insert(QStringLiteral("options"), options);
        safe.insert(QStringLiteral("allowCustom"), item.value(QStringLiteral("allow_custom")).toBool(true));
        safe.insert(QStringLiteral("skippable"), item.value(QStringLiteral("skippable")).toBool(true));
        result.append(safe);
    }
    return result;
}

QString ClarificationParser::serializeAnswers(const QVariantList &questions, const QVariantList &answers) {
    QStringList lines{QStringLiteral("Уточнения пользователя:")};
    for (qsizetype index = 0; index < questions.size(); ++index) {
        const QVariantMap question = questions.at(index).toMap();
        const QString answer = index < answers.size() ? answers.at(index).toString().trimmed() : QString();
        lines.append(QStringLiteral("Вопрос: %1\nОтвет: %2")
            .arg(question.value(QStringLiteral("question")).toString(),
                 answer.isEmpty() ? QStringLiteral("Пропущено") : answer));
    }
    return lines.join(QStringLiteral("\n"));
}
