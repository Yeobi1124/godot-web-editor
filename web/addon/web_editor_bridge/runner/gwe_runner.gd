extends Node
## 테스트 실행과 스크립트 검사 (웹 에디터 브라우저와 GitHub Actions가 함께 쓴다)
##
## test  : res://tests/test_*.gd 의 test_* 함수를 실행한다. 함수는 assert 도우미(t)를 인자로 받는다.
##           func test_move(t): t.ok(조건, "설명"); t.eq(실제, 기대, "설명")
##         테스트 중 스크립트 오류(SCRIPT ERROR, 파싱 오류)도 실패로 친다.
## check : 프로젝트의 모든 .gd를 다시 읽어 파싱 오류를 모은다 (addons/, 숨김 폴더 제외).
##
## 결과는 마지막에 "GWE_RESULT {json}" 한 줄로 출력한다. 실패/오류가 있으면 종료 코드 1.

const RESULT_PREFIX := "GWE_RESULT "


## 엔진 오류를 모으는 로거 (GDScript 런타임 오류는 예외가 아니라서 이렇게 잡는다)
class ErrorCatcher extends Logger:
	var errors: Array[Dictionary] = []
	var _lock := Mutex.new()

	func _log_error(function: String, file: String, line: int, code: String, rationale: String, _editor_notify: bool, error_type: int, _backtraces: Array[ScriptBacktrace]) -> void:
		if error_type == ERROR_TYPE_WARNING:
			return
		_lock.lock()
		errors.append({"message": rationale if rationale != "" else code, "file": file, "line": line, "function": function})
		_lock.unlock()

	func take() -> Array[Dictionary]:
		_lock.lock()
		var out := errors.duplicate()
		errors.clear()
		_lock.unlock()
		return out

	func _log_message(_message: String, _error: bool) -> void:
		pass


class T:
	var failures: Array[Dictionary] = []
	var current := ""

	func ok(cond: bool, msg: String = "") -> void:
		if not cond:
			failures.append({"test": current, "message": msg if msg != "" else "조건이 거짓"})

	func eq(actual, expected, msg: String = "") -> void:
		if typeof(actual) != typeof(expected) or actual != expected:
			failures.append({"test": current, "message": "%s 기대값 %s, 실제 %s" % [msg, var_to_str(expected), var_to_str(actual)]})


static func _error_text(e: Dictionary) -> String:
	return "%s (%s:%d)" % [e.message, e.file, e.line]


## mode: "test" 또는 "check". filter: 파일 이름에 포함될 문자열(test 모드)
func run(mode: String, filter: String = "") -> Dictionary:
	var started := Time.get_ticks_msec()
	var catcher := ErrorCatcher.new()
	OS.add_logger(catcher)
	var result := _run_check(catcher) if mode == "check" else _run_tests(catcher, filter)
	OS.remove_logger(catcher)
	result["mode"] = "check" if mode == "check" else "test"
	result["ms"] = Time.get_ticks_msec() - started
	result["godot"] = Engine.get_version_info().string
	return result


func _run_tests(catcher: ErrorCatcher, filter: String) -> Dictionary:
	var t := T.new()
	var tests: Array[Dictionary] = []
	var dir := DirAccess.open("res://tests")
	if dir == null:
		return {"ok": false, "passed": 0, "total": 0, "tests": [], "failures": [], "note": "res://tests 폴더가 없습니다. tests/test_*.gd 파일에 test_ 로 시작하는 함수를 만드세요."}
	var files := Array(dir.get_files()).filter(func(f): return f.begins_with("test_") and f.ends_with(".gd") and (filter == "" or filter in f))
	files.sort()
	catcher.take()
	for file in files:
		var path: String = "res://tests/" + file
		var script = ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var load_errors := catcher.take()
		if script == null or not script is GDScript or not script.can_instantiate() or not load_errors.is_empty():
			var msg := "스크립트를 불러오지 못함" + ("" if load_errors.is_empty() else ": " + ", ".join(load_errors.map(_error_text)))
			t.failures.append({"test": file.get_basename(), "message": msg})
			tests.append({"name": file.get_basename(), "ok": false, "ms": 0})
			print("  FAIL %s (불러오기 실패)" % file)
			continue
		var suite = script.new()
		if suite is Node:
			add_child(suite)
		for m in suite.get_method_list():
			var name: String = m.name
			if not name.begins_with("test_"):
				continue
			t.current = "%s::%s" % [file.get_basename(), name]
			var before := t.failures.size()
			var t0 := Time.get_ticks_msec()
			suite.call(name, t)
			for e in catcher.take():
				t.failures.append({"test": t.current, "message": "스크립트 오류 " + _error_text(e)})
			var ok := t.failures.size() == before
			tests.append({"name": t.current, "ok": ok, "ms": Time.get_ticks_msec() - t0})
			print("  %s %s" % ["PASS" if ok else "FAIL", t.current])
		if suite is Node:
			remove_child(suite)
			suite.free()
	var passed := tests.filter(func(x): return x.ok).size()
	for f in t.failures:
		printerr("FAIL  %s: %s" % [f.test, f.message])
	print("결과: %d/%d 통과" % [passed, tests.size()])
	return {"ok": t.failures.is_empty() and tests.size() > 0, "passed": passed, "total": tests.size(), "tests": tests, "failures": t.failures}


func _run_check(catcher: ErrorCatcher) -> Dictionary:
	var scripts: Array[String] = []
	_collect("res://", scripts)
	scripts.sort()
	var errors: Array[Dictionary] = []
	catcher.take()
	for path in scripts:
		ResourceLoader.load(path, "", ResourceLoader.CACHE_MODE_IGNORE)
		var found := catcher.take()
		for e in found:
			# 엔진 내부 위치(.cpp)에서 나온 오류는 줄 번호가 의미 없다. 같은 파일의 파싱 오류가 이미 있으면 "불러오기 실패" 중복은 뺀다
			var in_script := String(e.file).begins_with("res://")
			if not in_script and found.size() > 1 and String(e.message).begins_with("Failed to load script"):
				continue
			var file: String = e.file if in_script else path
			var line: int = e.line if in_script else 0
			errors.append({"path": file, "line": line, "message": e.message})
			printerr("ERROR %s:%d %s" % [file, line, e.message])
	print("스크립트 %d개 검사, 오류 %d건" % [scripts.size(), errors.size()])
	return {"ok": errors.is_empty(), "files": scripts.size(), "errors": errors}


func _collect(dir_path: String, out: Array[String]) -> void:
	var dir := DirAccess.open(dir_path)
	if dir == null:
		return
	dir.include_hidden = false
	for sub in dir.get_directories():
		if dir_path == "res://" and sub == "addons":
			continue
		_collect(dir_path.path_join(sub), out)
	for f in dir.get_files():
		if f.ends_with(".gd"):
			out.append(dir_path.path_join(f))


## 결과 출력 후 종료 코드 (0: 통과, 1: 실패/오류)
static func report(result: Dictionary) -> int:
	print(RESULT_PREFIX + JSON.stringify(result))
	return 0 if result.get("ok", false) else 1
