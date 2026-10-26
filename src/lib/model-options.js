// Пункты <select> со списком моделей — общие для popup и страницы настроек.

function formatSize(bytes) {
  return bytes ? `${(bytes / 1e9).toFixed(1)} GB` : "";
}

// models — из listModels(); selected — модель из настроек. Если её нет в списке,
// первым идёт неактивный пункт «(не найдена)» или «выберите модель».
export function modelOptions(models, selected) {
  const options = models.map((m) => {
    const details = [m.parameterSize, m.quantization, formatSize(m.size)].filter(Boolean).join(", ");
    return new Option(details ? `${m.name} · ${details}` : m.name, m.name);
  });
  if (!models.some((m) => m.name === selected)) {
    const label = selected ? `${selected} (not found)` : "— choose a model —";
    const placeholder = new Option(label, selected);
    placeholder.disabled = true;
    options.unshift(placeholder);
  }
  return options;
}
