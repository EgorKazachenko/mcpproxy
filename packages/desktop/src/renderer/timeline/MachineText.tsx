/**
 * Машинные фрагменты: пути, регексы, хэши и элементы команды.
 *
 * Моноширинным и без переноса по словам: разорванный аргумент читается как два разных, а
 * кириллическая буква в имени флага пропорциональным шрифтом неотличима от латинской.
 */
const MACHINE = /(\/[\w./~-]+|~\/[\w./-]+|\^[^\s]+\$|[\w.-]+:\d+|--?[\w-]+|\S+\.(?:sh|log|json|yaml|ts|tsx))/g;

export function MachineText({ text }: { text: string }) {
  const parts = text.split(MACHINE);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="mono nowrap">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </>
  );
}
