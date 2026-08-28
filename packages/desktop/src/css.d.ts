/**
 * `moduleResolution: NodeNext` не резолвит спецификатор CSS: у него нет ни типов, ни
 * расширения, которое TypeScript знает. Объявления ниже — единственный способ импортировать
 * стили, не отключая проверку модулей целиком.
 */
declare module '@mcpproxy/design/css';
declare module '*.css';
