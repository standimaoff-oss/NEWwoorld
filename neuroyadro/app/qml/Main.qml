import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

ApplicationWindow {
    id: window
    width: 1380
    height: 900
    minimumWidth: 360
    minimumHeight: 540
    readonly property bool compact: width < 900
    visible: true
    title: "НейроЯдро"
    color: "#111315"

    readonly property color background: "#111315"
    readonly property color surface: "#191c20"
    readonly property color raised: "#22262b"
    readonly property color border: "#31363d"
    readonly property color textMain: "#f3f5f7"
    readonly property color textMuted: "#9da6b2"
    readonly property color accent: "#8f9cff"
    readonly property color userBubble: "#252b3e"
    readonly property color assistantBubble: "#1b1f23"

    FileDialog {
        id: modelPicker
        title: "Выберите GGUF-модель"
        nameFilters: ["GGUF model (*.gguf)", "All files (*)"]
        onAccepted: chatController.chooseModel(selectedFile.toString())
    }

    Drawer {
        id: settingsDrawer
        edge: Qt.RightEdge
        width: Math.min(420, window.width * 0.92)
        height: window.height
        modal: true
        background: Rectangle { color: window.surface }
        ColumnLayout {
            anchors.fill: parent
            anchors.margins: 26
            spacing: 20
            Label { text: "Настройки"; color: window.textMain; font.pixelSize: 25; font.weight: Font.DemiBold }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 6
                Label { text: "Локальная модель"; color: window.textMuted; font.pixelSize: 12; font.capitalization: Font.AllUppercase }
                Label { text: chatController.modelStatus; color: window.textMain; wrapMode: Text.Wrap; Layout.fillWidth: true }
                Button {
                    id: selectModelButton
                    text: "Выбрать GGUF…"
                    onClicked: modelPicker.open()
                    contentItem: Text { text: selectModelButton.text; color: window.background; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                    background: Rectangle { color: window.accent; radius: 9 }
                }
            }
            Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; implicitHeight: 1; color: window.border }
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 8
                Label { text: "Приватность"; color: window.textMuted; font.pixelSize: 12; font.capitalization: Font.AllUppercase }
                Label {
                    Layout.fillWidth: true
                    text: "История хранится в локальной SQLite-базе. В этой версии сетевой поиск не активирован и сообщения не отправляются во внешний сервис."
                    color: window.textMain; wrapMode: Text.Wrap; lineHeight: 1.25
                }
            }
            Item { Layout.fillHeight: true }
            Label { text: "НейроЯдро · MVP"; color: window.textMuted; font.pixelSize: 12 }
        }
    }

    RowLayout {
        anchors.fill: parent
        spacing: 0

        Rectangle {
            id: sidebar
            Layout.fillHeight: true
            Layout.preferredWidth: window.compact ? 58 : Math.max(250, Math.min(310, window.width * 0.23))
            color: "#15181b"
            border.color: window.border
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: 14
                spacing: 12
                RowLayout {
                    Layout.fillWidth: true
                    Label { visible: !window.compact; text: "НейроЯдро"; color: window.textMain; font.pixelSize: 20; font.weight: Font.DemiBold; Layout.fillWidth: true }
                    Rectangle {
                        Layout.preferredWidth: 25; Layout.preferredHeight: 25; implicitWidth: 25; implicitHeight: 25
                        radius: 12.5; color: window.accent
                        Text { anchors.centerIn: parent; text: "N"; color: window.background; font.bold: true }
                    }
                }
                Button {
                    id: newChatButton
                    Layout.fillWidth: true
                    text: window.compact ? "+" : "+ Новый чат"
                    enabled: !chatController.generating
                    onClicked: chatController.createChat()
                    contentItem: Text { text: newChatButton.text; color: window.background; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.weight: Font.DemiBold }
                    background: Rectangle { color: newChatButton.enabled ? window.accent : "#535861"; radius: 9 }
                }
                Label { visible: !window.compact; text: "ЧАТЫ"; color: window.textMuted; font.pixelSize: 11; font.letterSpacing: 1.2; topPadding: 8 }
                ListView {
                    id: chatList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: 4
                    model: chatController.chatModel
                    delegate: ItemDelegate {
                        id: chatDelegate
                        width: ListView.view.width
                        height: window.compact ? 48 : 63
                        highlighted: chatId === chatController.currentChatId
                        onClicked: chatController.selectChat(chatId)
                        background: Rectangle {
                            radius: 8
                            color: chatDelegate.highlighted ? "#292f42" : (chatDelegate.hovered ? "#20242a" : "transparent")
                        }
                        contentItem: Column {
                            anchors.left: parent.left; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
                            spacing: 3
                            Text { text: window.compact ? title.left(1) : title; color: window.textMain; elide: Text.ElideRight; width: parent.width; font.pixelSize: window.compact ? 18 : 14; font.weight: Font.Medium; horizontalAlignment: window.compact ? Text.AlignHCenter : Text.AlignLeft }
                            Text { visible: !window.compact; text: preview.length > 0 ? preview : "Пустой диалог"; color: window.textMuted; elide: Text.ElideRight; width: parent.width; font.pixelSize: 12 }
                        }
                    }
                    ScrollBar.vertical: ScrollBar { }
                }
                RowLayout {
                    visible: !window.compact
                    Layout.fillWidth: true
                    Button {
                        id: renameButton
                        Layout.fillWidth: true; text: "Переименовать"
                        enabled: chatController.currentChatId >= 0 && !chatController.generating
                        onClicked: renameField.opened = !renameField.opened
                        contentItem: Text { text: renameButton.text; color: window.textMuted; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.pixelSize: 12 }
                        background: Rectangle { color: "transparent"; border.color: window.border; radius: 7 }
                    }
                    Button {
                        id: deleteButton
                        text: "Удалить"; enabled: !chatController.generating
                        onClicked: chatController.deleteCurrentChat()
                        contentItem: Text { text: deleteButton.text; color: "#f0a4a4"; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.pixelSize: 12 }
                        background: Rectangle { color: "transparent"; border.color: window.border; radius: 7 }
                    }
                }
                TextField {
                    id: renameField
                    Layout.fillWidth: true
                    property bool opened: false
                    visible: !window.compact && opened
                    placeholderText: "Название чата"
                    color: window.textMain
                    placeholderTextColor: window.textMuted
                    selectByMouse: true
                    onAccepted: { chatController.renameChat(text); text = ""; opened = false }
                    background: Rectangle { color: window.raised; radius: 7; border.color: window.border }
                }
            }
        }

        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: window.background

            ColumnLayout {
                anchors.fill: parent
                anchors.leftMargin: window.compact ? 10 : Math.max(20, window.width * 0.035)
                anchors.rightMargin: window.compact ? 10 : Math.max(20, window.width * 0.035)
                spacing: 0

                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 18
                    Layout.bottomMargin: 12
                    Label { text: window.compact ? "N" : "Диалог"; color: window.textMain; font.pixelSize: 20; font.weight: Font.DemiBold; Layout.fillWidth: true }
                    Label { text: chatController.modelStatus; color: window.textMuted; font.pixelSize: window.compact ? 10 : 12; elide: Text.ElideRight; Layout.maximumWidth: window.compact ? 110 : 440 }
                    Button {
                        id: settingsButton
                        text: "⚙"; font.pixelSize: 18; onClicked: settingsDrawer.open()
                        contentItem: Text { text: settingsButton.text; color: window.textMuted; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                        background: Rectangle { color: settingsButton.hovered ? window.raised : "transparent"; radius: 8 }
                    }
                }

                Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; implicitHeight: 1; color: window.border }

                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: 13
                    Layout.bottomMargin: 13
                    spacing: 14
                    Label { visible: !window.compact; text: "Сила раздумывания"; color: window.textMain; font.pixelSize: 13 }
                    Slider {
                        id: thinkingSlider
                        Layout.fillWidth: true
                        from: 0; to: 100; stepSize: 1
                        value: chatController.reasoningStrength
                        onMoved: chatController.setReasoningStrength(Math.round(value))
                        background: Rectangle {
                            x: thinkingSlider.leftPadding; y: thinkingSlider.topPadding + thinkingSlider.availableHeight / 2 - height / 2
                            width: thinkingSlider.availableWidth; height: 5; radius: 3; color: window.border
                            Rectangle { width: thinkingSlider.visualPosition * parent.width; height: parent.height; radius: parent.radius; color: window.accent }
                        }
                        handle: Rectangle { x: thinkingSlider.leftPadding + thinkingSlider.visualPosition * (thinkingSlider.availableWidth - width); y: thinkingSlider.topPadding + thinkingSlider.availableHeight / 2 - height / 2; width: 20; height: 20; radius: 10; color: window.textMain; border.color: window.accent; border.width: 3 }
                    }
                    Column {
                        Layout.preferredWidth: window.compact ? 48 : 225
                        Text { text: window.compact ? (chatController.reasoningStrength + "%") : (chatController.reasoningLabel + " · " + chatController.reasoningStrength + "%"); color: window.accent; font.pixelSize: 12 }
                        Text { visible: !window.compact; text: chatController.reasoningDetail; color: window.textMuted; font.pixelSize: 11; width: 225; elide: Text.ElideRight }
                    }
                }

                ListView {
                    id: messageList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    Layout.topMargin: 7
                    clip: true
                    spacing: 18
                    model: chatController.messageModel
                    onContentHeightChanged: positionViewAtEnd()
                    ScrollBar.vertical: ScrollBar { }
                    delegate: Item {
                        id: messageDelegate
                        width: messageList.width
                        height: bubble.height
                        property var clarificationAnswers: []
                        Column {
                            id: bubble
                            width: Math.min(parent.width, sender === "user" ? parent.width * 0.82 : parent.width * 0.9)
                            x: sender === "user" ? parent.width - width : 0
                            spacing: 6
                            Label { text: sender === "user" ? "ВЫ" : "НЕЙРОЯДРО"; color: window.textMuted; font.pixelSize: 10; font.letterSpacing: 1.2; x: sender === "user" ? parent.width - width : 0 }
                            Rectangle {
                                width: parent.width; height: messageText.implicitHeight + 28; radius: 13
                                color: sender === "user" ? window.userBubble : window.assistantBubble
                                border.color: sender === "user" ? "#384365" : window.border
                                Text {
                                    id: messageText
                                    anchors.fill: parent; anchors.margins: 14
                                    text: content + (streaming ? "▍" : "")
                                    color: window.textMain; wrapMode: Text.Wrap; textFormat: Text.PlainText
                                    font.pixelSize: 15; lineHeight: 1.28
                                }
                            }
                            Text {
                                visible: sender === "assistant" && (completionTokens > 0 || streaming)
                                text: streaming ? "Генерация…" : ("~ " + promptTokens + " prompt · " + completionTokens + " токенов · " + Number(tokensPerSecond).toFixed(1) + " ток/с · " + Number(elapsedSeconds).toFixed(1) + " с · раздумывания: " + reasoningStrength + "% ~")
                                color: window.textMuted; font.pixelSize: 11; x: 4
                            }
                            Rectangle {
                                visible: clarification.length > 0
                                width: parent.width; height: clarificationColumn.implicitHeight + 26
                                radius: 11; color: "#20263a"; border.color: "#465278"
                                Column {
                                    id: clarificationColumn
                                    anchors.left: parent.left; anchors.right: parent.right; anchors.margins: 13
                                    spacing: 12
                                    Text { text: "Нужно уточнение"; color: window.accent; font.bold: true; font.pixelSize: 13 }
                                    Repeater {
                                        model: clarification
                                        delegate: Column {
                                            id: clarificationQuestion
                                            width: parent.width; spacing: 7
                                            property var questionData: modelData
                                            property int questionIndex: index
                                            Text { text: questionData.question; color: window.textMain; wrapMode: Text.Wrap; width: parent.width; font.pixelSize: 14 }
                                            Repeater {
                                                model: questionData.options
                                                delegate: Button {
                                                    id: optionButton
                                                    width: parent.width; text: modelData
                                                    onClicked: { let copy = messageDelegate.clarificationAnswers.slice(); copy[clarificationQuestion.questionIndex] = optionButton.text; messageDelegate.clarificationAnswers = copy }
                                                    contentItem: Text { text: optionButton.text; color: window.textMain; leftPadding: 10; verticalAlignment: Text.AlignVCenter; wrapMode: Text.Wrap }
                                                    background: Rectangle { color: window.raised; radius: 7; border.color: optionButton.hovered ? window.accent : window.border }
                                                }
                                            }
                                            TextField {
                                                visible: questionData.allowCustom; width: parent.width
                                                placeholderText: "Свой вариант"; placeholderTextColor: window.textMuted; color: window.textMain
                                                onTextEdited: { let copy = messageDelegate.clarificationAnswers.slice(); copy[clarificationQuestion.questionIndex] = text; messageDelegate.clarificationAnswers = copy }
                                                background: Rectangle { color: "#171b21"; border.color: window.border; radius: 7 }
                                            }
                                        }
                                    }
                                    Row {
                                        spacing: 8
                                        Button {
                                            id: continueButton
                                            text: "Продолжить"
                                            onClicked: chatController.submitClarification(clarification, messageDelegate.clarificationAnswers)
                                            contentItem: Text { text: continueButton.text; color: window.background; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.weight: Font.DemiBold }
                                            background: Rectangle { color: window.accent; radius: 8 }
                                        }
                                        Button {
                                            id: skipClarificationButton
                                            text: "Пропустить"
                                            onClicked: chatController.submitClarification(clarification, [])
                                            contentItem: Text { text: skipClarificationButton.text; color: window.textMuted; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter }
                                            background: Rectangle { color: "transparent"; border.color: window.border; radius: 8 }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Label {
                        anchors.centerIn: parent
                        visible: messageList.count === 0
                        text: chatController.modelPath.length > 0 ? "Начните диалог" : "Выберите GGUF-модель в настройках, затем начните диалог"
                        color: window.textMuted; font.pixelSize: 15
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.topMargin: 14
                    Layout.bottomMargin: 18
                    implicitHeight: composer.implicitHeight + 20
                    radius: 13; color: window.surface; border.color: composer.activeFocus ? window.accent : window.border
                    RowLayout {
                        anchors.fill: parent; anchors.margins: 10; spacing: 10
                        TextArea {
                            id: composer
                            Layout.fillWidth: true
                            placeholderText: chatController.modelPath.length > 0 ? "Напишите сообщение…" : "Сначала выберите GGUF-модель…"
                            placeholderTextColor: window.textMuted; color: window.textMain
                            enabled: !chatController.generating
                            wrapMode: TextEdit.Wrap
                            font.pixelSize: 15
                            background: Rectangle { color: "transparent" }
                            Keys.onPressed: event => {
                                if ((event.modifiers & Qt.ControlModifier) && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) {
                                    chatController.send(composer.text); composer.clear(); event.accepted = true
                                }
                            }
                        }
                        Button {
                            id: sendButton
                            text: chatController.generating ? "Стоп" : (window.compact ? "➤" : "Отправить")
                            enabled: chatController.generating || (composer.text.trim().length > 0 && chatController.modelPath.length > 0)
                            onClicked: {
                                if (chatController.generating) chatController.cancelGeneration()
                                else { chatController.send(composer.text); composer.clear() }
                            }
                            contentItem: Text { text: sendButton.text; color: window.background; horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter; font.weight: Font.DemiBold }
                            background: Rectangle { color: sendButton.enabled ? window.accent : "#515761"; radius: 9 }
                        }
                    }
                }
                Text { visible: !window.compact; Layout.alignment: Qt.AlignHCenter; Layout.bottomMargin: 9; text: "Enter — новая строка · Ctrl+Enter — отправить · локальный режим"; color: window.textMuted; font.pixelSize: 11 }
            }
        }
    }

    Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter; anchors.bottom: parent.bottom; anchors.bottomMargin: 20
        width: Math.min(noticeText.implicitWidth + 34, parent.width - 50); height: noticeText.implicitHeight + 22
        radius: 10; color: "#303741"; border.color: window.border
        visible: chatController.notice.length > 0
        z: 2
        Text { id: noticeText; anchors.centerIn: parent; width: parent.width - 28; text: chatController.notice; color: window.textMain; wrapMode: Text.Wrap; horizontalAlignment: Text.AlignHCenter; font.pixelSize: 13 }
    }
}
