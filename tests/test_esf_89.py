import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
from extract_case_document import extract,infer,columns
class Esf89Tests(unittest.TestCase):
 def test_real_excel_89_repeated_identifiers_and_numeric_leading_zeros(self):
  for filename,count in [("purchase.xlsx",4),("sale.xlsx",10)]:
   p=Path(__file__).parent/"fixtures/esf-89"/filename;r=extract(p,p.name,{"groupId":"primary","typeId":"invoice"})
   self.assertEqual(len(r["rows"]),count);self.assertEqual(r["unparsedRows"],0)
   self.assertTrue(all(len(v["senderId"])==len(v["recipientId"])==12 for v in r["rows"]))
   first=r["rows"][0];self.assertEqual(first["attributes"]["fieldSources"]["senderId"]["cell"],"L2");self.assertEqual(first["attributes"]["fieldSources"]["recipientId"]["cell"],"AD2");self.assertEqual(first["contractRef"],"CON-SYN-1");self.assertEqual(first["esf"]["goodsName"],"Синтетическое оборудование")
   if filename=="purchase.xlsx":self.assertEqual(first["senderId"],"020000000002");self.assertEqual(first["recipientId"],"990000000001")
 def test_header_semantics_not_fixed_column_letters(self):
  headers=columns(["ИИН/БИН","Наименование поставщика по данным ИС ЭСФ","Адрес", "Наименование получателя по данным ИС ЭСФ","Примечание","ИИН/БИН","ИИН/БИН","Наименование грузополучателя"])
  mapping=infer(headers,{})
  self.assertEqual(mapping["senderId"],headers[0]);self.assertEqual(mapping["recipientId"],headers[5])
  moved=headers[3:6]+headers[:3]+headers[6:];mapping=infer(moved,{})
  self.assertEqual(mapping["senderId"],headers[0]);self.assertEqual(mapping["recipientId"],headers[5])
if __name__=="__main__":unittest.main()
