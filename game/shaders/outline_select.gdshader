shader_type spatial;
render_mode unshaded, cull_front, depth_draw_never;

// ============================================================
//  outline_select.gdshader — контур выделения объекта
//
//  Классический приём «перевернутый корпус»: рисуем ТОЛЬКО задние грани
//  (cull_front), раздутые вдоль нормали, одним цветом. Получается ровный
//  силуэт вокруг объекта любой сложности — без постпроцесса, без
//  трафаретов, без второго прохода по всему экрану.
//
//  Стоимость: один лишний draw call на выделенный объект. Сравните с
//  screen-space outline, который требует полного прохода по кадру
//  независимо от того, выделен один объект или ни одного.
//
//  Вешается как next_pass у материала объекта, поэтому не требует
//  отдельного меша или ноды.
// ============================================================

uniform vec4 outline_color : source_color = vec4(0.98, 0.72, 0.18, 1.0);
uniform float outline_width : hint_range(0.0, 0.2) = 0.018;

// Пульсация. Медленная и едва заметная: активная пульсация утомляет,
// но полностью статичный контур хуже читается в движущейся сцене.
uniform bool pulse_enabled = true;
uniform float pulse_speed : hint_range(0.0, 8.0) = 2.2;
uniform float pulse_depth : hint_range(0.0, 0.6) = 0.18;

// Затухание контура с расстоянием. На дальнем объекте постоянная ширина
// в метрах превращается в неразличимую линию, а постоянная в пикселях —
// в толстое пятно. Компенсируем расстоянием до камеры.
uniform float distance_fade : hint_range(0.0, 1.0) = 0.55;
uniform float max_visible_distance : hint_range(1.0, 500.0) = 60.0;

// Маска «взаимодействия»: объект можно выделить, но нельзя использовать
// (далеко, заперто). Цвет переключается, форма контура остаётся — игрок
// считывает и то, и другое одновременно.
uniform bool interactable = true;
uniform vec4 blocked_color : source_color = vec4(0.85, 0.22, 0.20, 1.0);

varying float v_alpha;

void vertex() {
	// Раздуваем вдоль нормали в пространстве модели.
	float width = outline_width;

	if (pulse_enabled) {
		width *= 1.0 + sin(TIME * pulse_speed) * pulse_depth;
	}

	// Расстояние до камеры — в мировых координатах. MODEL_MATRIX даёт
	// мировую позицию вершины; камера всегда в начале координат
	// пространства вида, поэтому берём длину от INV_VIEW_MATRIX.
	vec3 world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	vec3 camera_position = (INV_VIEW_MATRIX * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
	float distance_to_camera = length(world_position - camera_position);

	// Компенсация: чем дальше объект, тем сильнее раздуваем, чтобы контур
	// сохранял видимую толщину в пикселях.
	width *= mix(1.0, 1.0 + distance_to_camera * 0.06, distance_fade);

	VERTEX += NORMAL * width;

	// Полностью гасим контур за предельной дистанцией. Без этого в открытом
	// мире десятки объектов на горизонте рисовали бы золотые силуэты.
	float fade = 1.0 - smoothstep(max_visible_distance * 0.6, max_visible_distance,
			distance_to_camera);
	v_alpha = fade;
}

void fragment() {
	vec3 color = interactable ? outline_color.rgb : blocked_color.rgb;
	float alpha = (interactable ? outline_color.a : blocked_color.a) * v_alpha;
	if (alpha <= 0.001) {
		discard;
	}
	ALBEDO = color;
	ALPHA = alpha;
}
