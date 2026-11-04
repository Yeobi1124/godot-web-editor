extends Node
## 웹 에디터에서 실행하는 테스트/검사 씬. 브리지가 res://.godot/gwe_runner.json 에 {mode, filter}를 써 두고 이 씬을 실행한다.

const Runner := preload("gwe_runner.gd")
const CONFIG := "res://.godot/gwe_runner.json"


func _ready() -> void:
	await get_tree().process_frame
	var cfg = {}
	if FileAccess.file_exists(CONFIG):
		cfg = JSON.parse_string(FileAccess.get_file_as_string(CONFIG))
		if typeof(cfg) != TYPE_DICTIONARY:
			cfg = {}
	var runner: Node = Runner.new()
	add_child(runner)
	var code: int = Runner.report(runner.run(str(cfg.get("mode", "test")), str(cfg.get("filter", ""))))
	# 시작 직후 바로 끝내면 웹 버전은 오디오 초기화가 끝나기 전에 정리하다 멈출 수 있어 잠깐 기다린다
	await get_tree().create_timer(0.5).timeout
	get_tree().quit(code)
