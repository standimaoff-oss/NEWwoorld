shader_type spatial;
render_mode cull_back;

// ============================================================
//  dissolve_destruction.gdshader — растворение объекта при разрушении
//
//  Применяется к исходному мешу на те несколько кадров, пока осколки
//  уже появились, но исходный объект ещё виден. Без него разрушение
//  выглядит как «мгновенно исчез и появились обломки» — резко и дёшево.
//  С растворением по краям разлома объект уходит с раскалённой кромкой,
//  и разрушение читается как физическое событие.
//
//  Анимация управляется из GDScript (destructible.gd) через
//  `set_shader_parameter("dissolve_amount", ...)`.
// ============================================================

uniform float dissolve_amount : hint_range(0.0, 1.0) = 0.0;
uniform sampler2D noise_texture : filter_linear_mipmap, repeat_enable;

// Ширина светящейся кромки. Ноль — чистый срез без подсветки.
uniform float edge_width : hint_range(0.0, 0.2) = 0.035;
uniform vec4 edge_color : source_color = vec4(1.0, 0.45, 0.12, 1.0);
uniform float edge_emission : hint_range(0.0, 8.0) = 2.4;

// Масштаб шума. Крупный = рваные куски, мелкий = «пепел».
uniform float noise_scale : hint_range(0.1, 20.0) = 4.0;

// Куда «стекает» растворение. Обычно вверх (дым) или от точки удара.
uniform vec3 dissolve_direction = vec3(0.0, 1.0, 0.0);
uniform float direction_bias : hint_range(0.0, 1.0) = 0.35;

varying float v_threshold;

void vertex() {
	// Порог рассчитываем здесь, а не во фрагменте: он зависит только от
	// вершины, и считать его на каждый пиксель — лишняя работа.
	float noise_value = texture(noise_texture, UV * (noise_scale * 0.25)).r;
	float directional = dot(normalize(VERTEX), normalize(dissolve_direction)) * 0.5 + 0.5;
	v_threshold = mix(noise_value, directional, direction_bias);
}

void fragment() {
	// Расширяем диапазон порога, чтобы dissolve_amount == 1.0 гарантированно
	// растворял всё, а 0.0 — ничего. Без расширения крайние значения
	// «залипают» на частично видимом объекте.
	float threshold = clamp(v_threshold * 1.2 - 0.1, 0.0, 1.0);
	float mask = step(threshold, dissolve_amount);

	// Полоса кромки: пиксели, которые вот-вот исчезнут, светятся.
	float edge_mask = smoothstep(dissolve_amount, dissolve_amount + edge_width, threshold);
	float edge = (1.0 - edge_mask) * (1.0 - mask);

	ALBEDO *= 1.0 - edge * 0.5;
	EMISSION = edge_color.rgb * edge * edge_emission;
	ALPHA = 1.0 - mask;

	// Отбрасываем полностью растворённые пиксели до записи в буфер:
	// альфа-тест дешевле, чем рисовать невидимый фрагмент до конца.
	if (mask > 0.999) {
		discard;
	}
}
