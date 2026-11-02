shader_type spatial;
// cull_disabled — трава и листья двусторонние.
// shadows_disabled — СОЗНАТЕЛЬНО для травы/мелкой листвы: теней от неё
// всё равно не разглядеть, а стоимость отрисовки в shadow map реальна.
// Для крон деревьев этот render_mode нужно убрать: дерево без тени
// выглядит вклеенным в сцену.
render_mode cull_disabled, shadows_disabled;

// ============================================================
//  wind_foliage.gdshader — ветер на листве, траве и ткани
//
//  КЛЮЧЕВАЯ ИДЕЯ: все параметры приходят из ОДНОГО источника —
//  глобальных shader-параметров, которые публикует WindSystem
//  (game/scripts/systems/wind_system.gd). Поэтому вся листва в сцене
//  качается СОГЛАСОВАННО: одно направление, одни порывы, одна фаза.
//
//  Именно несогласованность отличает «живой мир» от набора независимых
//  анимаций. Если каждая травинка качается в своей фазе, глаз мгновенно
//  считывает подделку, даже не понимая почему.
//
//  Все uniform'ы ниже — global: они НЕ задаются у материала, а берутся
//  из RenderingServer.global_shader_parameter_set(). Проверку совпадения
//  имён делает tools/lint/shader_check.py.
// ============================================================

uniform vec3 wind_direction;
uniform float wind_strength;
uniform float wind_time;
uniform float wind_gust;
uniform float wind_turbulence;

// Насколько сильно материал реагирует на ветер. У травы 1.0, у ветки 0.4,
// у ствола 0.05 — иначе дерево гнётся как водоросль.
uniform float wind_response : hint_range(0.0, 3.0) = 1.0;

// Опорная точка «закрепления». Обычно это основание объекта: низ ствола,
// корень травы. Без якоря объект не гнётся, а улетает целиком.
// Y в локальных координатах ниже anchor_height считается неподвижным.
uniform float anchor_height : hint_range(-10.0, 10.0) = 0.0;

// Жёсткость: чем выше, тем меньше амплитуда на единицу высоты.
uniform float stiffness : hint_range(0.0, 8.0) = 1.6;

// Первичная амплитуда изгиба, метры.
uniform float primary_amplitude : hint_range(0.0, 1.5) = 0.18;

// Вторичная, быстрая «дрожь» листа. Даёт жизнь на слабом ветру,
// где основной изгиб почти незаметен.
uniform float secondary_amplitude : hint_range(0.0, 0.5) = 0.035;
uniform float secondary_frequency : hint_range(0.0, 20.0) = 6.5;

// Индивидуальная фаза объекта. Без неё все кусты одного типа качались бы
// абсолютно синхронно — это самый заметный артефакт «веба из ассетов».
// Задаётся на инстанс через instance uniform или vertex color.
uniform bool use_vertex_color_as_phase = true;

// Сколько брать фазы из UV, если vertex color не используется.
uniform float uv_phase_scale : hint_range(0.0, 4.0) = 1.0;

varying float v_wind_factor;

// Дешёвый хеш вместо полноценного шума: на вершинах он вызывается
// миллионы раз за кадр, и качество шума здесь не важно — важна цена.
float hash11(float p) {
	p = fract(p * 0.1031);
	p *= p + 33.33;
	p *= p + p;
	return fract(p);
}

float phase_of(vec3 world_pos, vec4 vertex_color, vec2 uv) {
	if (use_vertex_color_as_phase) {
		// Красный канал вершинного цвета — стандартное место под маску
		// фазы/веса при экспорте из Blender.
		return vertex_color.r * 6.2831853;
	}
	// Запасной путь: фаза из мировой позиции. Не требует данных в меше,
	// но даёт «волны» по ландшафту — заметно на однородных полях.
	return hash11(dot(world_pos.xz, vec2(12.9898, 78.233))) * 6.2831853
			+ uv.x * uv_phase_scale;
}

void vertex() {
	// Фаза берётся от МИРОВОЙ позиции объекта: иначе два куста, стоящие
	// рядом, но повёрнутые по-разному, качались бы в разные стороны.
	vec3 world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	float phase = phase_of(world_pos, COLOR, UV);

	// Высота над якорем, нормированная. Изгиб растёт квадратично с высотой:
	// реальная ветка у основания почти неподвижна и гнётся к концу.
	// Линейная зависимость выглядит как излом картона.
	float height_above_anchor = max(0.0, VERTEX.y - anchor_height);
	float bend_weight = pow(clamp(height_above_anchor / max(stiffness, 0.001), 0.0, 1.0), 2.0);

	// Общая сила ветра с учётом текущего порыва.
	float gust_boost = 1.0 + wind_gust * 2.0;
	float effective_strength = wind_strength * gust_boost * wind_response;

	// Основной изгиб — медленный, по направлению ветра.
	// Две синусоиды с разными частотами вместо одной: чистый синус
	// читается как механическая анимация за пару секунд наблюдения.
	float slow_wave = sin(wind_time * 1.1 + phase) * 0.6
			+ sin(wind_time * 0.47 + phase * 1.7) * 0.4;

	// Ветер задан в МИРОВОМ пространстве, а VERTEX здесь — в пространстве
	// модели (world_vertex_coords намеренно НЕ включён: с ним anchor_height
	// перестал бы быть «высотой над основанием объекта»). Поэтому направление
	// ветра переводим в пространство модели обратной матрицей.
	//
	// w = 0.0 — преобразуем направление, а не точку: сдвиг начала координат
	// на направление влиять не должен.
	vec3 world_wind_dir = normalize(wind_direction + vec3(0.0, 0.08, 0.0));
	vec3 wind_dir = normalize((inverse(MODEL_MATRIX) * vec4(world_wind_dir, 0.0)).xyz);
	vec3 primary_offset = wind_dir * (slow_wave * primary_amplitude * effective_strength);

	// Вторичная дрожь — по нормали листа, а не по ветру. Лист трепещет
	// вокруг своей плоскости, это физически другое движение.
	float flutter = sin(wind_time * secondary_frequency + phase * 3.1)
			* secondary_amplitude * effective_strength;
	vec3 secondary_offset = NORMAL * flutter;
	// NORMAL тоже в пространстве модели, поэтому вторичная дрожь
	// в дополнительном преобразовании не нуждается.

	// Турбулентность добавляет хаотичное смещение по XZ. Без неё ветер
	// выглядит как поток в аэродинамической трубе — слишком упорядоченно.
	float turbulence = wind_turbulence * bend_weight * 0.06 * effective_strength;
	vec3 turbulent_offset = vec3(
			sin(wind_time * 3.7 + phase * 2.3) * turbulence,
			0.0,
			cos(wind_time * 2.9 + phase * 1.9) * turbulence);

	VERTEX += (primary_offset + secondary_offset + turbulent_offset) * bend_weight;

	// Передаём фактор ветра во фрагментный шейдер: на сильном ветру
	// имеет смысл слегка темнить underside листа (он поворачивается).
	v_wind_factor = clamp(bend_weight * effective_strength, 0.0, 2.0);
}

void fragment() {
	// Мягкое затемнение обратной стороны при сильном ветре.
	// Дёшево (одно умножение) и заметно добавляет объёма кроне.
	float underside_shade = mix(1.0, 0.82, clamp(v_wind_factor * 0.5, 0.0, 1.0));
	ALBEDO *= underside_shade;
}
