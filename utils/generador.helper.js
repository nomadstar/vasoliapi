const express = require("express");
const fs = require("fs");
const path = require("path");
const docx = require("docx");
const { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, WidthType, ImageRun, BorderStyle } = docx;

function formatearFechaEspanol(fechaIso) {
    const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

    // Manejar tanto fechas ISO como fechas en formato YYYY-MM-DD
    let d;
    if (fechaIso.includes('T')) {
        d = new Date(fechaIso);
    } else {
        // Para formato YYYY-MM-DD
        const [year, month, day] = fechaIso.split('-');
        d = new Date(year, month - 1, day);
    }

    // Validar que la fecha sea válida
    if (isNaN(d.getTime())) {
        console.error('Fecha inválida:', fechaIso);
        return fechaIso; // Devolver original si no se puede formatear
    }

    return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
}

const ORDINALES = [
    "", "PRIMERO:", "SEGUNDO:", "TERCERO:", "CUARTO:", "QUINTO:",
    "SEXTO:", "SÉPTIMO:", "OCTAVO:", "NOVENO:", "DÉCIMO:",
    "UNDÉCIMO:", "DUODÉCIMO:", "DÉCIMO TERCERO:", "DÉCIMO CUARTO:",
    "DÉCIMO QUINTO:", "DÉCIMO SEXTO:", "DÉCIMO SÉPTIMO:",
    "DÉCIMO OCTAVO:", "DÉCIMO NOVENO:", "VIGÉSIMO:"
];

async function obtenerEmpresaDesdeBD(nombreEmpresa, db) {
    try {
        console.log("=== BUSCANDO EMPRESA EN BD ===");
        console.log("Nombre empresa buscado:", nombreEmpresa);

        if (!db || typeof db.collection !== 'function') {
            throw new Error("Base de datos no disponible");
        }

        const empresa = await db.collection('empresas').findOne({
            nombre: { $regex: new RegExp(nombreEmpresa, 'i') }
        });

        console.log("Empresa encontrada en BD:", empresa);

        if (empresa) {
            return {
                nombre: empresa.nombre,
                rut: empresa.rut,
                logo: empresa.logo
            };
        }

        const palabras = nombreEmpresa.toUpperCase().split(' ');
        for (const palabra of palabras) {
            if (palabra.length > 3) {
                const empresaPorPalabra = await db.collection('empresas').findOne({
                    nombre: { $regex: new RegExp(palabra, 'i') }
                });

                if (empresaPorPalabra) {
                    console.log("Empresa encontrada por palabra clave:", empresaPorPalabra);
                    return {
                        nombre: empresaPorPalabra.nombre,
                        rut: empresaPorPalabra.rut,
                        logo: empresaPorPalabra.logo
                    };
                }
            }
        }

        console.log("No se encontró empresa en BD");
        return null;

    } catch (error) {
        console.error('Error buscando empresa en BD:', error);
        return null;
    }
}

function crearLogoImagen(logoData) {
    if (!logoData || !logoData.fileData) {
        return null;
    }

    try {
        return new ImageRun({
            data: logoData.fileData.buffer,
            transformation: {
                width: 100,
                height: 100,
            },
            floating: {
                horizontalPosition: {
                    offset: 201440,
                },
                verticalPosition: {
                    offset: 201440,
                },
            }
        });
    } catch (error) {
        console.error('Error creando imagen del logo:', error);
        return null;
    }
}

function mapearDatosFormulario(responses, userData) {
    console.log("=== CAMPOS DISPONIBLES EN RESPONSES ===");
    Object.keys(responses).forEach(key => {
        console.log(`"${key}":`, responses[key]);
    });

    console.log("=== USER DATA ===");
    console.log("User data recibido:", userData);

    const empresaUsuario = userData?.empresa || "[EMPRESA NO ESPECIFICADA]";
    const nombreUsuario = userData?.nombre || "[NOMBRE NO ESPECIFICADO]";

    const datosMapeados = {
        empresa: empresaUsuario,
        responsable: nombreUsuario,

        trabajador: responses["Nombre del trabajador"] || "[TRABAJADOR NO ESPECIFICADO]",
        rut_trabajador: responses["Rut del trabajador"] || "",

        fecha_inicio: responses["Fecha de inicio de modificación"] || "",
        fecha_contrato: responses["Fecha del contrato vigente"] || "",
        termino_contrato: responses["FECHA DE TÉRMINO DEL CONTRATADO FIJO:"] || "",

        tipo_contrato: Array.isArray(responses["Tipo de Anexo"]) ?
            responses["Tipo de Anexo"] :
            [responses["Tipo de Anexo"]].filter(Boolean),
        nuevo_cargo: responses["NUEVO CARGO TRABAJADOR:"] || "",

        sueldo: responses["MONTO DEL NUEVO SUELDO:"] || "",
        colacion: responses["MONTO DE NUEVA ASIGNACIÓN DE COLACIÓN:"] || "",
        movilizacion: responses["MONTO DE NUEVA ASIGNACIÓN DE MOVILIZACIÓN:"] || "",

        hora_ingreso: responses["HORA DE INGRESO DE JORNADA LABORAL:"] || "",
        hora_salida: responses["HORA DE SALIDA DE JORNADA LABORAL:"] || "",
        hora_ingreso_colacion: responses["HORA DE INGRESO COLACIÓN:"] || "",
        hora_salida_colacion: responses["HORA DE SALIDA COLACIÓN:"] || "",

        nombre_bono: responses["NOMBRE DEL BONO:"] || "",
        monto_bono: responses["MONTO DEL BONO:"] || "",
        periodo_bono: responses["PLAZO BONO"] || "",
        condiciado: responses["CONDICIONADO:"] || "",

        local: responses["CAMBIO DE DOMICILIO LABORAL DEL TRABAJADOR:"] || "",
        nuevo_domicilio: responses["NUEVO DOMICILIO TRABAJADOR:"] || "",
        telefono: responses["NUEVO NÚMERO DE TELÉFONO TRABAJADOR:"] || "",
        correo: responses["NUEVO CORREO TRABAJADOR:"] || "",

        doble_turno: responses["DOBLE TURNO:"] || "",
        comentarios_turno: responses["COMENTARIOS"] || "", // ← NUEVO CAMPO

        // Campos para cuando DOBLE TURNO = "NO"
        un_solo_turno: Array.isArray(responses["UN SOLO TURNO"]) ?
            responses["UN SOLO TURNO"].join(", ") :
            responses["UN SOLO TURNO"] || "",
        horario_entrada_unico: responses["HORARIO DE ENTRADA:"] || "",
        horario_salida_unico: responses["HORARIO DE SALIDA:"] || "",
        dia_compensacion_unico: responses["DÍA DE COMPENSACIÓN:"] || "",
        horario_compensacion_entrada_unico: responses["HORARIO DE ENTRADA (COMPENSACIÓN):"] || "",
        horario_compensacion_salida_unico: responses["HORARIO DE SALIDA (COMPENSACIÓN):"] || "",

        desde_colacion: responses["DESDE:"] || "",
        hasta_colacion: responses["HASTA:"] || ""
    };

    console.log("=== DATOS MAPEADOS ACTUALIZADOS ===");
    console.log("Empresa final:", datosMapeados.empresa);
    console.log("Responsable final:", datosMapeados.responsable);
    console.log("Comentarios turno:", datosMapeados.comentarios_turno);
    console.log(JSON.stringify(datosMapeados, null, 2));

    return datosMapeados;
}

function generarClausulasCondicionales(datos) {
    return [
        {
            condicion: () => datos.local && datos.local.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Por mutuo acuerdo de las partes involucradas, desde el ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    " ejercerá funciones en local de ",
                    { text: datos.local, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.nuevo_domicilio && datos.nuevo_domicilio.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "A contar del ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    ", su dirección particular es modificada a ",
                    { text: datos.nuevo_domicilio, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.telefono && datos.telefono.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Número telefónico de contacto actualizado a: ",
                    { text: datos.telefono, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.correo && datos.correo.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Correo electrónico de contacto actualizado a: ",
                    { text: datos.correo, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.sueldo && datos.sueldo.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "El empleador se compromete a pagar al trabajador una remuneración mensual de $",
                    { text: datos.sueldo, bold: true },
                    ", monto que ambas partes reconocen y aceptan como sueldo base."
                ]);
            }
        },
        {
            condicion: () => {
                const tipos = Array.isArray(datos.tipo_contrato)
                    ? datos.tipo_contrato
                    : [datos.tipo_contrato].filter(Boolean);
                return tipos.some(tipo => tipo && tipo.toUpperCase().includes("ANEXO INDEFINIDO"));
            },
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Desde el ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    ", la duración del contrato se modifica a INDEFINIDO."
                ]);
            }
        },
        {
            condicion: () => {
                const tipos = Array.isArray(datos.tipo_contrato)
                    ? datos.tipo_contrato
                    : [datos.tipo_contrato].filter(Boolean);
                return tipos.some(tipo => tipo && tipo.toUpperCase().includes("RENOVACIÓN CONTRATO PLAZO FIJO"));
            },
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Desde el ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    ", el contrato se renueva hasta el ",
                    { text: formatearFechaEspanol(datos.termino_contrato), bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.nuevo_cargo && datos.nuevo_cargo.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Desde el ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    " el nuevo cargo es: ",
                    { text: datos.nuevo_cargo, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.colacion && datos.colacion.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "El empleador pagará al trabajador una asignación mensual de colación equivalente a la suma de $",
                    { text: datos.colacion, bold: true },
                    ", destinada a cubrir gastos de alimentación derivados de la prestación de servicios. El pago de esta asignación será efectuado conjuntamente con las remuneraciones mensuales, sin que su otorgamiento se encuentre condicionado a la realización de tareas específicas o al cumplimiento de obligaciones distintas a las propias del contrato de trabajo."
                ]);
            }
        },
        {
            condicion: () => datos.movilizacion && datos.movilizacion.trim() !== "",
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "El empleador pagará al trabajador una asignación mensual de movilización equivalente a la suma de $",
                    { text: datos.movilizacion, bold: true },
                    ", destinada a cubrir gastos de transporte derivados de la prestación de servicios. El pago de esta asignación será efectuado conjuntamente con las remuneraciones mensuales, sin que su otorgamiento se encuentre condicionado a la realización de tareas específicas o al cumplimiento de obligaciones distintas a las propias del contrato de trabajo."
                ]);
            }
        },
        {
            condicion: () => (datos.hora_ingreso && datos.hora_ingreso.trim() !== "") ||
                (datos.hora_salida && datos.hora_salida.trim() !== ""),
            contenido: (agregarModificacion) => {
                const textos = [
                    "A contar del ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    " Horario de trabajo modificado: Desde "
                ];

                if (datos.hora_ingreso) {
                    textos.push({ text: `las ${datos.hora_ingreso} hrs.`, bold: true });
                } else {
                    textos.push("horario actual");
                }

                textos.push(" hasta ");

                if (datos.hora_salida) {
                    textos.push({ text: `las ${datos.hora_salida} hrs.`, bold: true });
                } else {
                    textos.push("horario actual.");
                }

                agregarModificacion(textos);
            }
        },
        {
            condicion: () => (datos.hora_ingreso_colacion && datos.hora_ingreso_colacion.trim() !== "") ||
                (datos.hora_salida_colacion && datos.hora_salida_colacion.trim() !== ""),
            contenido: (agregarModificacion) => {
                const textos = [
                    "A contar del ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    " Horario de colación modificado Desde "
                ];

                if (datos.hora_ingreso_colacion) {
                    textos.push({ text: `${datos.hora_ingreso_colacion} hrs.`, bold: true });
                } else {
                    textos.push("horario ingreso colacion actual");
                }

                textos.push(" hasta ");

                if (datos.hora_salida_colacion) {
                    textos.push({ text: `${datos.hora_salida_colacion} hrs.`, bold: true });
                } else {
                    textos.push("horario salida colacion actual.");
                }

                agregarModificacion(textos);
            }
        },
        {
            condicion: () => datos.nombre_bono && datos.nombre_bono.trim() !== "",
            contenido: (agregarModificacion) => {
                const textos = [
                    "El empleador pagará al trabajador un bono ",
                    { text: datos.nombre_bono, bold: true },
                    " con temporalidad: ",
                    { text: datos.periodo_bono || "", bold: true },
                    " con un valor de $",
                    { text: datos.monto_bono || "", bold: true },
                    "."
                ];

                if (datos.condiciado) {
                    textos.push(` bajo la siguiente condición: ${datos.condiciado}`);
                }

                agregarModificacion(textos);
            }
        },
        {
            condicion: () => datos.desde_colacion && datos.hasta_colacion,
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "A contar del ",
                    { text: formatearFechaEspanol(datos.fecha_inicio), bold: true },
                    " el horario de colación se modifica desde ",
                    { text: datos.desde_colacion, bold: true },
                    " hasta ",
                    { text: datos.hasta_colacion, bold: true },
                    "."
                ]);
            }
        },
        {
            condicion: () => datos.doble_turno && datos.doble_turno.toUpperCase() === "SI" && datos.comentarios_turno,
            contenido: (agregarModificacion) => {
                agregarModificacion([
                    "Se establece cambio de turno del trabajador según los siguientes detalles: ",
                    { text: datos.comentarios_turno, bold: true }
                ]);
            }
        },
        {
            condicion: () => datos.doble_turno && datos.doble_turno.toUpperCase() === "NO",
            contenido: (agregarModificacion) => {
                const textos = [];

                if (datos.un_solo_turno) {
                    textos.push(
                        "Se define como día trabajado para el turno único los días: ",
                        { text: datos.un_solo_turno, bold: true },
                        " en horario de ",
                        { text: datos.horario_entrada_unico || "", bold: true },
                        " a ",
                        { text: datos.horario_salida_unico || "", bold: true },
                        ". "
                    );
                }

                if (datos.dia_compensacion_unico) {
                    textos.push(
                        "Se define el día de compensación el día ",
                        { text: datos.dia_compensacion_unico, bold: true }
                    );

                    if (datos.horario_compensacion_entrada_unico || datos.horario_compensacion_salida_unico) {
                        textos.push(
                            " en el horario de ",
                            { text: datos.horario_compensacion_entrada_unico || "", bold: true },
                            " a ",
                            { text: datos.horario_compensacion_salida_unico || "", bold: true }
                        );
                    }
                    textos.push(". ");
                }

                if (textos.length > 0) {
                    agregarModificacion(textos);
                }
            }
        }
    ];
}

async function generarAnexo(datos, responseId, db) {
    console.log("=== VERIFICANDO CONEXIÓN BD EN generarAnexo ===");
    console.log("db disponible:", !!db);
    console.log("db tipo:", typeof db);

    if (!db) {
        throw new Error("Base de datos no inicializada.");
    }

    if (typeof db.collection !== 'function') {
        throw new Error("db.collection no es una función - conexión inválida");
    }

    const ciudad = "PROVIDENCIA";
    const hoy = formatearFechaEspanol(new Date().toISOString().split("T")[0]);
    const trabajador = datos.trabajador || "[NOMBRE DEL TRABAJADOR]";
    const empresa = datos.empresa || "[EMPRESA]";
    const responsable = datos.responsable || "[RESPONSABLE]";

    let rutEmpresa = "";
    try {
        const empresaInfo = await db.collection('empresas').findOne({
            nombre: empresa
        });
        rutEmpresa = empresaInfo ? empresaInfo.rut : "";
        console.log("RUT empresa encontrado:", rutEmpresa);
    } catch (error) {
        console.error('Error buscando RUT de empresa:', error);
    }

    let empresaInfo = await obtenerEmpresaDesdeBD(empresa, db);
    let logo = empresaInfo ? empresaInfo.logo : null;

    console.log("=== INFORMACIÓN DE EMPRESA FINAL ===");
    console.log("Empresa:", empresa);
    console.log("Responsable:", responsable);
    console.log("RUT:", rutEmpresa);
    console.log("Logo disponible:", !!logo);

    const children = [];

    if (logo) {
        const logoImagen = crearLogoImagen(logo);
        if (logoImagen) {
            children.push(new Paragraph({
                children: [logoImagen]
            }));
            children.push(new Paragraph({ text: "" }));
        }
    }

    children.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
            new TextRun({
                text: "ANEXO DE MODIFICACIÓN Y ACTUALIZACIÓN DE CONTRATO INDIVIDUAL DE TRABAJO",
                bold: true,
                size: 28
            })
        ]
    }));

    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));

    children.push(new Paragraph({
        alignment: AlignmentType.JUSTIFIED,
        children: [
            new TextRun(`En ${ciudad} a ${hoy}, entre `),
            new TextRun({ text: `${empresa} `, bold: true }),
            new TextRun("representada por "),
            new TextRun({ text: `${responsable} `, bold: true }),
            new TextRun("y Don(ña) "),
            new TextRun({ text: `${trabajador.toUpperCase()}`, bold: true }),
            new TextRun(`, se conviene modificar el Contrato de Trabajo vigente de fecha ${formatearFechaEspanol(datos.fecha_contrato)} y sus posteriores ANEXOS.`)
        ]
    }));

    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));

    children.push(new Paragraph({
        children: [new TextRun({ text: "MODIFICACIÓN", bold: true })]
    }));

    children.push(new Paragraph({ text: "" }));

    let modificacionNum = 1;
    function agregarModificacion(textos = []) {
        const ordinal = ORDINALES[modificacionNum] || `${modificacionNum}°`;
        modificacionNum++;

        children.push(new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            children: [
                new TextRun({ text: ordinal, bold: true })
            ]
        }));

        const paragraphChildren = [];
        textos.forEach(t => {
            if (typeof t === "string") {
                paragraphChildren.push(new TextRun(t));
            } else {
                paragraphChildren.push(new TextRun({ text: t.text, bold: t.bold || false }));
            }
        });

        children.push(new Paragraph({
            alignment: AlignmentType.JUSTIFIED,
            children: paragraphChildren
        }));

        children.push(new Paragraph({ text: "" }));
    }

    const clausulasCondicionales = generarClausulasCondicionales(datos);
    clausulasCondicionales.forEach(clausula => {
        if (clausula.condicion()) {
            clausula.contenido(agregarModificacion);
        }
    });

    agregarModificacion([
        "Queda Expresamente convenido que las cláusulas existentes en el contrato de trabajo celebrado por las partes el día ",
        { text: formatearFechaEspanol(datos.fecha_contrato), bold: true },
        " y anexos posteriores, y que no hayan sido objeto de modificación o actualización por este documento, se mantienen plenamente vigentes en todo aquello que no sea contrario o incompatible con lo pactado en este anexo."
    ]);

    agregarModificacion([
        "En expresa conformidad con lo precedentemente estipulado las partes firman el presente anexo en dos ejemplares de idéntico tenor y fecha, declarando el trabajador haber recibido uno de ellos en este acto. El otro queda en los archivos de ",
        { text: empresa, bold: true },
        "."
    ]);

    // REEMPLAZA completamente la sección de la tabla de firmas con esto:

    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));
    children.push(new Paragraph({ text: "" }));

    // SOLUCIÓN CON TABLA MEJORADA
    children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: [4000, 4000], // 2 columnas explícitas
        borders: {
            top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
            insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
        },
        rows: [
            // Fila 1: Líneas de firma
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ text: "_____________________________", alignment: AlignmentType.CENTER })]
                    }),
                    new TableCell({
                        children: [new Paragraph({ text: "_____________________________", alignment: AlignmentType.CENTER })]
                    })
                ]
            }),
            // Fila 2: Títulos
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ text: "Empleador / Representante Legal", alignment: AlignmentType.CENTER })]
                    }),
                    new TableCell({
                        children: [new Paragraph({ text: "Trabajador", alignment: AlignmentType.CENTER })]
                    })
                ]
            }),
            // Fila 3: RUTs
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ text: `RUT: ${rutEmpresa}`, alignment: AlignmentType.CENTER })]
                    }),
                    new TableCell({
                        children: [new Paragraph({ text: `RUT: ${datos.rut_trabajador}`, alignment: AlignmentType.CENTER })]
                    })
                ]
            }),
            // Fila 4: Nombres
            new TableRow({
                children: [
                    new TableCell({
                        children: [new Paragraph({ text: empresa, alignment: AlignmentType.CENTER })]
                    }),
                    new TableCell({
                        children: [new Paragraph({ text: trabajador.toUpperCase(), alignment: AlignmentType.CENTER })]
                    })
                ]
            }),
            // Fila 5: Representante (solo columna izquierda)
            
        ]
    }));

    const doc = new Document({
        sections: [
            {
                properties: {},
                children: children
            }
        ]
    });

    const buffer = await Packer.toBuffer(doc);

    const IDdoc = `ANEXO_${trabajador.replace(/\s+/g, '_').toUpperCase()}_${Date.now()}`;

    console.log("=== INTENTANDO INSERTAR EN BD ===");
    console.log("IDdoc:", IDdoc);
    console.log("Buffer length:", buffer.length);

    await db.collection('docxs').insertOne({
        IDdoc: IDdoc,
        docxFile: buffer,
        responseId: responseId,
        tipo: 'docx',
        createdAt: new Date(),
        updatedAt: new Date()
    });

    console.log("DOCX guardado en BD exitosamente");

    return {
        IDdoc: IDdoc,
        buffer: buffer,
        tipo: 'docx'
    };
}

async function generarDocumentoTxt(responses, responseId, db) {
    try {
        console.log("=== GENERANDO DOCUMENTO TXT MEJORADO ===");

        let contenidoTxt = "FORMULARIO - RESPUESTAS\n";
        contenidoTxt += "========================\n\n";

        // Procesar respuestas normales
        let index = 1;
        Object.keys(responses).forEach((pregunta) => {
            // Saltar el campo _contexto
            if (pregunta === '_contexto') return;

            const respuesta = responses[pregunta];

            contenidoTxt += `${index}. ${pregunta}\n`;

            if (Array.isArray(respuesta)) {
                contenidoTxt += `   - ${respuesta.join('\n   - ')}\n\n`;
            } else if (respuesta && typeof respuesta === 'object') {
                contenidoTxt += `   ${JSON.stringify(respuesta, null, 2)}\n\n`;
            } else {
                contenidoTxt += `   ${respuesta || 'Sin respuesta'}\n\n`;
            }
            index++;
        });

        // PROCESAR CAMPOS CONTEXTUALES (DUPLICADOS)
        if (responses._contexto) {
            contenidoTxt += "\n--- INFORMACIÓN DE TURNOS DETALLADA ---\n\n";

            Object.keys(responses._contexto).forEach(contexto => {
                contenidoTxt += `TURNO: ${contexto}\n`;

                Object.keys(responses._contexto[contexto]).forEach(pregunta => {
                    const respuesta = responses._contexto[contexto][pregunta];
                    contenidoTxt += `   ${pregunta}: ${respuesta}\n`;
                });
                contenidoTxt += "\n";
            });
        }

        contenidoTxt += `\nGenerado el: ${new Date().toLocaleString()}`;

        const buffer = Buffer.from(contenidoTxt, 'utf8');
        const IDdoc = `FORMULARIO_${responseId}_${Date.now()}`;

        await db.collection('docxs').insertOne({
            IDdoc: IDdoc,
            docxFile: buffer,
            responseId: responseId,
            tipo: 'txt',
            createdAt: new Date(),
            updatedAt: new Date()
        });

        console.log("TXT MEJORADO guardado en BD exitosamente");

        return {
            IDdoc: IDdoc,
            buffer: buffer,
            tipo: 'txt'
        };

    } catch (error) {
        console.error('Error generando TXT mejorado:', error);
        throw error;
    }
}

async function generarAnexoDesdeRespuesta(responses, responseId, db, section, userData) {
    try {
        console.log("=== DETECTANDO TIPO DE FORMULARIO ===");
        console.log("Section recibida:", section);
        console.log("User data from response:", userData);

        const esAnexo = section === "Anexos";

        if (esAnexo) {
            console.log("Generando DOCX para anexo...");
            const datos = mapearDatosFormulario(responses, userData);
            return await generarAnexo(datos, responseId, db);
        } else {
            console.log("Generando TXT para formulario regular...");
            return await generarDocumentoTxt(responses, responseId, db);
        }
    } catch (error) {
        console.error('Error en generarAnexoDesdeRespuesta:', error);
        throw error;
    }
}

module.exports = {
    generarAnexo,
    generarAnexoDesdeRespuesta,
    generarDocumentoTxt
};