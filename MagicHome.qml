Item {
	anchors.fill: parent

	Column {
		width: parent.width
		height: parent.height
		spacing: 0

		// ------------------------------------------------------------------
		// Scope notice
		// ------------------------------------------------------------------
		Column {
			width: 450
			height: 118
			Rectangle {
				width: parent.width
				height: parent.height - 10
				color: "#1f3a5f"
				radius: 5
				Column {
					x: 12
					y: 10
					width: parent.width - 24
					spacing: 4
					Text {
						color: theme.primarytextcolor
						text: "Analog RGB controllers only"
						font.pixelSize: 15
						font.family: "Poppins"
						font.bold: true
					}
					Text {
						color: theme.primarytextcolor
						width: parent.width
						wrapMode: Text.WordWrap
						text: "Works with Magic Home / Zengge controllers that drive a 4-pin \"+ R G B\" strip using the legacy unencrypted protocol.\n\nThe whole strip is ONE colour zone - it cannot show per-LED effects. Newer encrypted-firmware units are not supported."
						font.pixelSize: 11
						font.family: "Poppins"
						font.bold: false
					}
				}
			}
		}

		// ------------------------------------------------------------------
		// Add by IP
		// ------------------------------------------------------------------
		Column {
			width: 450
			height: 112
			Rectangle {
				width: parent.width
				height: parent.height - 10
				color: "#141414"
				radius: 5

				Column {
					x: 12
					y: 10
					width: parent.width - 24
					spacing: 6

					Text {
						color: theme.primarytextcolor
						text: "Add a controller by IP"
						font.pixelSize: 16
						font.family: "Poppins"
						font.bold: true
					}
					Text {
						color: theme.primarytextcolor
						width: parent.width
						wrapMode: Text.WordWrap
						text: "Recommended. Broadcast discovery runs automatically but is blocked on many networks. Set a DHCP reservation so the address does not change."
						font.pixelSize: 11
						font.family: "Poppins"
					}

					Row {
						spacing: 8

						Rectangle {
							width: 220
							height: 34
							radius: 5
							border.color: "#1c1c1c"
							border.width: 2
							color: "#141414"

							TextField {
								id: controllerIP
								width: 200
								height: parent.height
								x: 10
								color: theme.primarytextcolor
								font.family: "Poppins"
								font.bold: true
								font.pixelSize: 16
								verticalAlignment: TextInput.AlignVCenter
								placeholderText: "192.0.2.50"
								validator: RegularExpressionValidator {
									regularExpression: /^((?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])\.){0,3}(?:[0-1]?[0-9]?[0-9]|2[0-4][0-9]|25[0-5])$/
								}
								onEditingFinished: {
									if (controllerIP.acceptableInput && controllerIP.text.length > 0) {
										discovery.forceDiscover(controllerIP.text);
									}
								}
								background: Item {
									width: parent.width
									height: parent.height
								}
							}
						}

						Item {
							width: 90
							height: 34
							Rectangle {
								anchors.fill: parent
								color: "#D65A00"
								radius: 5
							}
							Text {
								anchors.centerIn: parent
								color: "#FFFFFF"
								text: "Add"
								font.pixelSize: 14
								font.family: "Poppins"
								font.bold: true
							}
							MouseArea {
								anchors.fill: parent
								hoverEnabled: true
								cursorShape: Qt.PointingHandCursor
								onClicked: {
									if (controllerIP.acceptableInput && controllerIP.text.length > 0) {
										discovery.forceDiscover(controllerIP.text);
									}
								}
							}
						}
					}
				}
			}
		}

		// ------------------------------------------------------------------
		// Known controllers
		// ------------------------------------------------------------------
		Text {
			color: theme.primarytextcolor
			text: "  Controllers"
			font.pixelSize: 16
			font.family: "Poppins"
			font.bold: true
		}

		ListView {
			id: controllerList
			model: service.controllers
			width: 450
			height: parent.height - 275
			clip: true
			spacing: 6

			ScrollBar.vertical: ScrollBar { id: controllerListScrollBar }

			delegate: Item {
				width: 450
				height: 78

				Rectangle {
					width: 440
					height: 70
					radius: 5
					color: "#141414"
					border.color: "#1c1c1c"
					border.width: 2

					Column {
						x: 12
						y: 10
						spacing: 2
						width: 250

						Text {
							color: theme.primarytextcolor
							text: device.name
							font.pixelSize: 14
							font.family: "Poppins"
							font.bold: true
							elide: Text.ElideRight
							width: 250
						}
						Text {
							color: theme.primarytextcolor
							text: device.ip + "  ·  port 5577"
							font.pixelSize: 11
							font.family: "Poppins"
						}
						Text {
							color: device.offline ? "#D65A00" : "#4CAF50"
							text: device.offline ? "Not responding to discovery" : "Reachable"
							font.pixelSize: 11
							font.family: "Poppins"
							font.bold: true
						}
					}

					Row {
						x: 300
						y: 20
						spacing: 8

						Item {
							width: 60
							height: 28
							Rectangle {
								anchors.fill: parent
								color: "#2c2c2c"
								radius: 5
							}
							Text {
								anchors.centerIn: parent
								color: theme.primarytextcolor
								text: "Unlink"
								font.pixelSize: 11
								font.family: "Poppins"
							}
							MouseArea {
								anchors.fill: parent
								hoverEnabled: true
								cursorShape: Qt.PointingHandCursor
								onClicked: { device.startRemove(); }
							}
						}

						Item {
							width: 60
							height: 28
							Rectangle {
								anchors.fill: parent
								color: "#7a2222"
								radius: 5
							}
							Text {
								anchors.centerIn: parent
								color: "#FFFFFF"
								text: "Delete"
								font.pixelSize: 11
								font.family: "Poppins"
							}
							MouseArea {
								anchors.fill: parent
								hoverEnabled: true
								cursorShape: Qt.PointingHandCursor
								onClicked: { device.startDelete(); }
							}
						}
					}
				}
			}
		}
	}
}
