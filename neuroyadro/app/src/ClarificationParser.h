#pragma once

#include <QVariantList>
#include <QString>

class ClarificationParser final {
public:
    // Returns an empty list unless the complete assistant message is a valid, bounded card.
    static QVariantList parse(const QString &content);
    static QString serializeAnswers(const QVariantList &questions, const QVariantList &answers);
};
