#include "ChatController.h"

#include <QGuiApplication>
#include <QDir>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QStandardPaths>

int main(int argc, char *argv[]) {
    QQuickStyle::setStyle(QStringLiteral("Basic"));
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("NeuroYadro"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("local.neuroyadro"));
    QCoreApplication::setApplicationName(QStringLiteral("НейроЯдро"));

    QString dataDirectory = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation);
    if (dataDirectory.isEmpty()) {
        dataDirectory = QDir::homePath() + QStringLiteral("/.neuroyadro");
    }
    QDir().mkpath(dataDirectory);
    ChatController controller(QDir(dataDirectory).filePath(QStringLiteral("neuroyadro.sqlite")));

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("chatController"), &controller);
    engine.loadFromModule("NeuroYadro", "Main");
    if (engine.rootObjects().isEmpty()) {
        return 1;
    }
    return app.exec();
}
